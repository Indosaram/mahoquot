import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { Database } from 'bun:sqlite';
import { benchmarkOwner, benchmarkFetch, bounded, phaseObservations } from './bench-locality.mjs';
const fetch = benchmarkFetch;

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function nearestRankPercentile(sorted, percentile) {
  if (sorted.length === 0) return 0.0;
  const index = Math.ceil((percentile / 100.0) * sorted.length) - 1;
  const clamped = Math.max(0, Math.min(index, sorted.length - 1));
  return sorted[clamped];
}

export async function getProcessStats(pid, {
  spawn = (argv, options) => Bun.spawn(argv, options),
  wait = bounded,
  listFds = async path => (await import('node:fs/promises')).readdir(path),
} = {}) {
  // These short-lived helpers own their pipes and child independently of the
  // gateway owner, so an unavailable measurement cannot strand a subprocess.
  const capture = async argv => {
    let child;
    try { child = spawn(argv, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' }); }
    catch { return null; } // e.g. lsof is not installed
    const drains = [];
    let output = '', bytes = 0, overflow = false;
    try {
      for (const [index, stream] of [child.stdout, child.stderr].entries()) {
        const drain = (async () => {
          for await (const chunk of stream) {
            if (index === 0) {
              bytes += chunk.byteLength;
              if (bytes <= 1024 * 1024) output += Buffer.from(chunk).toString();
              else overflow = true;
            }
          }
        })();
        drains.push(drain);
        drain.catch(() => {}); // finally observes and reports drain failures
      }
      const [status] = await wait(Promise.all([child.exited, ...drains]), `${argv[0]} capture`, 15000);
      return status === 0 && !overflow ? output.trim() : null;
    } catch {
      return null; // deadline/nonzero/unavailable is not a zero measurement
    } finally {
      const errors = [];
      try { if (child.exitCode === null) child.kill('SIGKILL'); }
      catch (error) { errors.push(error); }
      const results = await Promise.allSettled([
        wait(child.exited, `${argv[0]} reap`, 15000),
        ...drains.map((drain, index) => wait(drain, `${argv[0]} pipe ${index} drain`, 15000)),
      ]);
      errors.push(...results.filter(result => result.status === 'rejected').map(result => result.reason));
      if (errors.length) throw new AggregateError(errors, `${argv[0]} stat cleanup failed`);
    }
  };

  const rssText = await capture(['ps', '-o', 'rss=', '-p', String(pid)]);
  const rss = rssText && /^\d+$/.test(rssText) ? Number(rssText) * 1024 : null;
  const rssBytes = Number.isSafeInteger(rss) && rss > 0 ? rss : null;
  let fds = null;
  try {
    // Linux exposes the descriptor table directly; lsof is not always installed.
    fds = (await listFds(`/proc/${pid}/fd`)).length;
  } catch {
    const lsofText = await capture(['lsof', '-p', String(pid)]);
    const lines = lsofText ? lsofText.split('\n').filter(Boolean) : [];
    fds = lines.length > 1 && /^COMMAND\s/.test(lines[0]) ? lines.length - 1 : null;
  }
  return { rssBytes, fds };
}

export async function getInFlight(gwPort) {
  try {
    const res = await fetch(`http://127.0.0.1:${gwPort}/metrics`);
    const text = await res.text();
    const match = text.match(/mahoquot_in_flight_requests\s+(\d+)/);
    return res.ok && match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

async function getAdminStats(gwPort, managementKey = 'mgmt-secret') {
  try {
    const res = await fetch(`http://127.0.0.1:${gwPort}/admin/stats`, {
      headers: {
        authorization: `Bearer ${managementKey}`,
      },
    });
    if (res.ok) {
      return await res.json();
    }
  } catch {}
  return null;
}

export async function runResilienceBenchmark(env = process.env) {
  const owner = benchmarkOwner();
  const observations = observationJournal();
  const evidence = phaseObservations();
  let activePhase = null;
  let rawPath;
  const fetch = evidence.observeFetch(benchmarkFetch, (input, init) => {
    if (!String(input).includes('/v1/chat/completions')) return null;
    const id = String(init.body ?? '').match(/b(?:6-burst|7-postcommit|7-failover|10-abort|10-slow|11-ceiling|12-traffic|13-telemetry)-\d+/)?.[0] ?? null;
    return { phase: activePhase, id };
  });
  let gatewayChild;
  let pipeDrains = [];
  const requestBindings = new Map();
  const requestHeaders = id => {
    const observationId = randomUUID();
    requestBindings.set(id, observationId);
    return { 'content-type': 'application/json', authorization: 'Bearer benchkey', 'x-mahoquot-observation-id': observationId };
  };
  try {
  const phase = async name => {
    activePhase = name;
    evidence.event(name, 'phase-start');
    env.F4_PHASE_HOOK?.(name);
    if (name !== 'DONE') {
      const stats = await getProcessStats(gatewayChild.pid);
      evidence.raw.resources.push({ phase: name, pid: gatewayChild.pid, observed_at: Date.now(), rss_bytes: stats.rssBytes, fd_count: stats.fds });
    }
  };
  const gateway = env.GWBIN ?? join(root, '.omo/shared-target/debug/mahoquot-gateway');
  const mockPort = Number(env.MOCK_PORT ?? 18880);
  const gwPort = Number(env.GW_PORT ?? 18881);

  if (mockPort < 18840 || mockPort > 18899 || gwPort < 18840 || gwPort > 18899 || mockPort === gwPort) {
    throw new Error('benchmark requires leased numeric loopback ports between 18840 and 18899');
  }

  const destination = resolve(env.BENCH_EVIDENCE ?? join(root, '.omo/evidence', `bench-resilience-${randomUUID()}`));
  await mkdir(destination, { recursive: true });
  rawPath = join(destination, 'resilience-raw.json');

  const authDir = join(destination, 'auth');
  await mkdir(authDir, { recursive: true });

  const mockOverride = `http://127.0.0.1:${mockPort}`;

  const burstAuth = {
    identity_slug: 'burst',
    access_token: 'stale-burst-token',
    account_id: 'burst-account',
    email: 'burst@example.invalid',
    expired: '2020-01-01T00:00:00Z',
    id_token: 'burst-id',
    last_refresh: '2019-01-01T00:00:00Z',
    refresh_token: 'burst-refresh-token',
    type: 'plus',
    upstream_override: mockOverride,
  };
  await writeFile(join(authDir, 'codex-a-burst.json'), JSON.stringify(burstAuth, null, 2));

  const acc1Auth = {
    identity_slug: 'acc1',
    access_token: 'token-acc1',
    account_id: 'account-1',
    email: 'acc1@example.invalid',
    expired: '2099-01-01T00:00:00Z',
    id_token: 'id-acc1',
    last_refresh: '2026-01-01T00:00:00Z',
    refresh_token: 'rt-acc1',
    type: 'plus',
    upstream_override: mockOverride,
  };
  await writeFile(join(authDir, 'codex-b-acc1.json'), JSON.stringify(acc1Auth, null, 2));

  const acc2Auth = {
    identity_slug: 'acc2',
    access_token: 'token-acc2',
    account_id: 'account-2',
    email: 'acc2@example.invalid',
    expired: '2099-01-01T00:00:00Z',
    id_token: 'id-acc2',
    last_refresh: '2026-01-01T00:00:00Z',
    refresh_token: 'rt-acc2',
    type: 'plus',
    upstream_override: mockOverride,
  };
  await writeFile(join(authDir, 'codex-c-acc2.json'), JSON.stringify(acc2Auth, null, 2));

  const gwConfig = `
routing:
  strategy: fill-first
request-retry: 2
max-retry-credentials: 2
usage-statistics-enabled: true
api-keys:
  - benchkey
remote-management:
  secret-key: mgmt-secret
`;
  await writeFile(join(authDir, 'config.yaml'), gwConfig);
  evidence.event(null, 'initial-config', { yaml: gwConfig, credentials: [burstAuth, acc1Auth, acc2Auth], max_concurrent_inference: 512 });

  let oauthHitCount = 0;
  let b7Active = false;
  let b7RateLimitCount = 0;
  let activeInMock = 0;
  let heldResponseDelayMs = 0;
  let releaseHold = () => {};
  let holdPromise = Promise.resolve();
  let admissionChanged = () => {};

  const heldStreams = new Map();
  const upstreamCancelled = new Set();
  const mockExecutionLog = [];
  evidence.raw.upstream_executions = mockExecutionLog;
  const removedTokensObserved = new Set();
  const removedTokens = new Set();

  owner.release(() => releaseHold());
  const mockServer = owner.serve({
    port: mockPort,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === '/oauth/token') {
        oauthHitCount++;
        evidence.event(activePhase, 'refresh-request', { path: url.pathname, body: await req.text(), generation: oauthHitCount, response: { access_token: 'refreshed-burst-token', refresh_token: 'refreshed-burst-rt', expires_in: 3600 } });
        return Response.json({
          access_token: 'refreshed-burst-token',
          refresh_token: 'refreshed-burst-rt',
          id_token: 'refreshed-burst-idt',
          token_type: 'Bearer',
          expires_in: 3600,
        });
      }

      if (url.pathname.includes('/models')) {
        return Response.json({
          data: [{ id: 'gpt-5.6-sol', object: 'model', owned_by: 'openai' }],
        });
      }

      const authHeader = req.headers.get('authorization') ?? '';
      const requestBody = await req.text();
      const logicalId = requestBody.match(/b(?:6-burst|7-postcommit|7-failover|10-abort|10-slow|11-ceiling|12-traffic|13-telemetry)-\d+/)?.[0] ?? null;
      const execEntry = {
        id: logicalId,
        authHeader,
        path: url.pathname,
        time: Date.now(),
        phase: activePhase,
        execution_id: randomUUID(),
        request_body: requestBody,
        observation_id: req.headers.get('x-mahoquot-observation-id'),
        status: 200,
      };

      for (const removed of removedTokens) {
        if (authHeader.includes(removed)) {
          removedTokensObserved.add(removed);
        }
      }

      if (authHeader.includes('stale-burst-token')) {
        execEntry.status = 401;
        mockExecutionLog.push(execEntry);
        return Response.json({ error: { message: 'stale_token' } }, { status: 401 });
      }

      if (b7Active && authHeader.includes('refreshed-burst-token')) {
        b7RateLimitCount++;
        execEntry.status = 429;
        mockExecutionLog.push(execEntry);
        return Response.json({ error: { message: 'rate_limited', code: 429 } }, { status: 429 });
      }

      if (heldResponseDelayMs > 0) {
        activeInMock++;
        evidence.event(activePhase, 'admission-held', { logical_id: logicalId, active_in_mock: activeInMock });
        admissionChanged();
        await holdPromise;
        activeInMock--;
      }

      mockExecutionLog.push(execEntry);
      if (logicalId?.startsWith('b10-') || logicalId?.startsWith('b7-postcommit-')) {
        const stream = new ReadableStream({
          start(controller) {
            heldStreams.set(logicalId, controller);
            controller.enqueue(new TextEncoder().encode('event: response.created\ndata: {"type":"response.created"}\n\nevent: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"committed"}\n\n'));
          },
          cancel() {
            upstreamCancelled.add(logicalId);
            observations.add({ event: 'upstream-cancel', logical_id: logicalId });
          },
        });
        return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
      }
      const sseBody = 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"ok"}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"id":"fixture-complete","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":1}}}\n\n';
      return new Response(sseBody, {
        headers: {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
        },
      });
    },
  });

  gatewayChild = Bun.spawn([
    gateway,
    'serve',
    '--port', String(gwPort),
    '--bind', '127.0.0.1',
    '--auth-dir', authDir,
    '--config', join(authDir, 'config.yaml'),
    '--refresh-url', `http://127.0.0.1:${mockPort}/oauth/token`,
    '--max-concurrent-inference', '512',
  ], {
    env: {
      ...process.env,
      HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '',
      RUST_LOG: 'info',
      NO_COLOR: '1',
      MAHOQUOT_QA_LOOPBACK_ONLY: '1',
      MANAGEMENT_PASSWORD: 'mgmt-secret',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const gwProc = gatewayChild;
  const listening = observations.wait(events => events.some(event => event.event === 'listening'));
  pipeDrains = [gwProc.stdout, gwProc.stderr].map(async stream => {
    const decoder = new TextDecoder();
    let tail = '';
    for await (const bytes of stream) {
      tail += decoder.decode(bytes, { stream: true });
      const lines = tail.split('\n');
      tail = lines.pop();
      for (const line of lines) observations.line(line);
    }
    if (tail) observations.line(tail);
  });
  await bounded(Promise.race([listening, gwProc.exited.then(code => { throw new Error(`gateway exited before readiness: ${code}`); })]), 'gateway readiness');
  const health = await fetch(`http://127.0.0.1:${gwPort}/healthz`);
  if (!health.ok) throw new Error(`gateway health status ${health.status}`);
  await health.text();

  const gwChatUrl = `http://127.0.0.1:${gwPort}/v1/chat/completions`;

  const b6BurstSize = 100;
  await phase('B6');
  const b6Reqs = Array.from({ length: b6BurstSize }, async (_, i) => {
    const t0 = Date.now();
    try {
      const r = await fetch(gwChatUrl, {
        method: 'POST',
        headers: requestHeaders(`b6-burst-${i}`),
        body: JSON.stringify({
          model: 'gpt-5.6-sol',
          messages: [{ role: 'user', content: `b6-burst-${i}` }],
          stream: true,
        }),
      });
      const text = await r.text();
      const elapsed = Date.now() - t0;
      return { ok: r.status === 200, elapsed, status: r.status };
    } catch {
      return { ok: false, elapsed: Date.now() - t0, status: 500 };
    }
  });

  const b6Results = await Promise.all(b6Reqs);
  const b6SuccessCount = b6Results.filter(r => r.ok).length;
  const b6Latencies = b6Results.map(r => r.elapsed).sort((a, b) => a - b);
  const b6P99 = nearestRankPercentile(b6Latencies, 99.0);

  const burstDiskFile = JSON.parse(await readFile(join(authDir, 'codex-a-burst.json'), 'utf8'));
  evidence.event('B6', 'credential-file', { file: 'codex-a-burst.json', value: burstDiskFile });
  const diskTokenPreserved = burstDiskFile.access_token === 'refreshed-burst-token';
  const observedTokenGeneration = diskTokenPreserved ? (1 + oauthHitCount) : 1;

  const b6Report = {
    burst_size: b6BurstSize,
    token_generation: observedTokenGeneration,
    exact_refresh_count: oauthHitCount,
    replay_success_count: b6SuccessCount,
    disk_token_preserved: diskTokenPreserved,
    storm_p99_ms: b6P99,
    success_rate: b6BurstSize > 0 ? b6SuccessCount / b6BurstSize : 0.0,
  };

  b7Active = true;
  const b7LimitCases = 10;
  await phase('B7');
  const b7Latencies = [];

  for (let i = 0; i < b7LimitCases; i++) {
    const t0 = Date.now();
    try {
      const r = await fetch(gwChatUrl, {
        method: 'POST',
        headers: requestHeaders(`b7-failover-${i}`),
        body: JSON.stringify({
          model: 'gpt-5.6-sol',
          messages: [{ role: 'user', content: `b7-failover-${i}` }],
          stream: true,
        }),
      });
      const _ = await r.text();
      const elapsed = Date.now() - t0;
      if (r.status === 200) {
        b7Latencies.push(elapsed);
      }
    } catch {}
  }
  b7Active = false;

  // The pristine baseline (pre-Task 26) gates management with the master key.
  const managementKey = env.BENCH_MGMT_AUTH === 'master' ? 'benchkey' : 'mgmt-secret';
  const b7AdminStats = await getAdminStats(gwPort, managementKey);
  evidence.event('B7', 'admin-stats', { value: b7AdminStats });
  let falseAccountExclusionCount = 0;
  let burstCooledObserved = false;
  if (b7AdminStats?.accounts) {
    for (const acc of b7AdminStats.accounts) {
      const isCooldown = acc.health?.status === 'cooldown';
      if (acc.id === 'burst' && isCooldown) {
        burstCooledObserved = true;
      } else if (acc.id !== 'burst' && isCooldown) {
        falseAccountExclusionCount++;
      }
    }
  }

  const postcommit = [];
  for (let i = 0; i < b7LimitCases; i++) {
    const id = `b7-postcommit-${i}`;
    const phaseDeadline = AbortSignal.timeout(15000);
    const response = await bounded(fetch(gwChatUrl, {
      method: 'POST', headers: requestHeaders(id), signal: phaseDeadline,
      body: JSON.stringify({ model: 'gpt-5.6-sol', messages: [{ role: 'user', content: id }], stream: true }),
    }), 'B7 postcommit request');
    const reader = response.body.getReader();
    const committed = await bounded(readCommitted(reader), 'B7 downstream commit');
    evidence.event('B7', 'downstream-commit', { logical_id: id, observation_id: requestBindings.get(id), status: response.status, content_observed: committed });
    const recorded = observations.wait(events => correlatedLifecycle(events, requestBindings.get(id), 'recorded').length > 0);
    // Fault only after the downstream has actually consumed content.
    heldStreams.get(id).error(new Error('B7 injected postcommit transport failure'));
    evidence.event('B7', 'postcommit-fault', { logical_id: id, observation_id: requestBindings.get(id), action: 'upstream-controller-error' });
    // Catch only the stream's rejection inside the bounded operation: the
    // outer deadline must reject the benchmark, never count as a fault receipt.
    const failed = await bounded((async () => {
      let tail = '';
      try {
        for (;;) { const chunk = await reader.read(); if (chunk.done) break; tail += new TextDecoder().decode(chunk.value); }
      } catch (error) {
        // benchmarkFetch also owns an abort deadline; neither abort source
        // proves that the injected upstream fault reached the downstream.
        if (phaseDeadline.aborted || error?.name === 'TimeoutError' || error?.name === 'AbortError') throw error;
        return true;
      }
      phaseDeadline.throwIfAborted();
      return /"error"|response.failed|response.incomplete/.test(tail);
    })(), 'B7 postfault drain');
    evidence.event('B7', 'postcommit-drain', { logical_id: id, failure_observed: failed });
    await bounded(recorded, 'B7 finalizer');
    postcommit.push({ id, committed: response.ok && committed, failure_injected: true, failure_observed: failed });
  }
  const failoverBudgetRespected = Boolean(b7AdminStats?.failed_over && b7AdminStats.failed_over <= 2 * b7LimitCases);

  const b7AvgFailover = b7Latencies.length > 0
    ? (b7Latencies.reduce((a, b) => a + b, 0) / b7Latencies.length)
    : null;

  const b7Report = {
    rate_limits_injected: b7RateLimitCount,
    properly_scoped_cooling: burstCooledObserved && falseAccountExclusionCount === 0,
    failover_budget_respected: failoverBudgetRespected,
    committed_replay_prevented: postcommitReplayPrevented(postcommit, mockExecutionLog),
    postcommit_faults: postcommit,
    false_account_exclusion_count: falseAccountExclusionCount,
    average_failover_ms: b7AvgFailover !== null ? Number(b7AvgFailover.toFixed(1)) : null,
  };

  await phase('B10');
  const b10SlowCount = 100;
  const b10AbortCount = 100;
  const inFlightBefore = await getInFlight(gwPort);
  const b10Ids = Array.from({ length: b10AbortCount }, (_, i) => `b10-abort-${i}`);
  // All streams remain open at the upstream until the client cancels them.
  const clients = await bounded(Promise.all(b10Ids.map(async id => {
    const ac = new AbortController();
    const response = await fetch(gwChatUrl, {
      method: 'POST', headers: requestHeaders(id), signal: ac.signal,
      body: JSON.stringify({ model: 'gpt-5.6-sol', messages: [{ role: 'user', content: id }], stream: true }),
    });
    if (!response.ok || !await readCommitted(response.body.getReader())) throw new Error(`B10 no committed content: ${id}`);
    return ac;
  })), 'B10 held clients');
  const inFlightDuring = await getInFlight(gwPort);
  const terminated = observations.wait(events => b10Ids.every(id =>
    events.some(event => event.event === 'upstream-cancel' && event.logical_id === id)
      && correlatedLifecycle(events, requestBindings.get(id), 'recorded').length > 0));
  for (const ac of clients) ac.abort();
  await bounded(terminated, 'B10 upstream cancellation and finalization');

  const inFlightAfter = await getInFlight(gwPort);
  const leakedGuards = inFlightAfter === null || inFlightBefore === null ? null : Math.max(0, inFlightAfter - inFlightBefore);
  const gwStats = await getProcessStats(gwProc.pid);

  evidence.event('B10', 'in-flight-snapshots', { before: inFlightBefore, during: inFlightDuring, after: inFlightAfter });
  evidence.raw.resources.push({ phase: 'B10', pid: gwProc.pid, observed_at: Date.now(), rss_bytes: gwStats.rssBytes, fd_count: gwStats.fds });
  const b10Report = {
    slow_clients_tested: b10SlowCount,
    aborts_tested: b10AbortCount,
    held_in_flight: inFlightDuring,
    guard_released_once_count: b10Ids.filter(id => exactCancellation(observations.events, requestBindings.get(id))).length,
    leaked_guards: leakedGuards,
    zombie_upstream_tasks: b10Ids.filter(id => !upstreamCancelled.has(id)).length,
    abandoned_work_drained: b10Ids.every(id => upstreamCancelled.has(id) && exactCancellation(observations.events, requestBindings.get(id))),
    outstanding_fds: gwStats.fds,
    outstanding_rss_bytes: gwStats.rssBytes,
  };

  await phase('B11');
  heldResponseDelayMs = 1;
  holdPromise = new Promise(resolve => { releaseHold = resolve; });
  const b11TargetConcurrency = 525;
  const b11Start = Date.now();

  const httpAgent = new http.Agent({ keepAlive: false, maxSockets: 1000 });
  owner.release(() => httpAgent.destroy());
  let b11Accepted = 0;
  let b11503Count = 0;
  let b11Other = 0;
  const b11OtherStatuses = {};
  let earlyGateReleaseCount = 0;

  const b11Promises = [];
  for (let i = 0; i < b11TargetConcurrency; i++) {
    const settledTarget = i + 1;
    const admitted = new Promise(resolve => {
      admissionChanged = () => {
        if (activeInMock + b11503Count + b11Other + b11Accepted >= settledTarget) resolve();
      };
    });
    // Open connections one at a time: a simultaneous burst of 525 SYNs
    // overflows a small kernel listen backlog (macOS somaxconn=128) and is
    // reset before the gateway ever sees it. Every request is still held open
    // by the mock, so all 525 remain concurrent at the admission gate.
    let connected;
    const socketReady = new Promise((resolve) => { connected = resolve; });
    const attempt = evidence.begin('B11', `b11-ceiling-${i}`);
    b11Promises.push(new Promise((resolve) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port: gwPort,
        path: '/v1/chat/completions',
        method: 'POST',
        agent: httpAgent,
        headers: requestHeaders(`b11-ceiling-${i}`),
      }, (res) => {
        attempt.headers(res.statusCode);
        res.on('data', bytes => attempt.chunk(bytes));
        res.on('error', error => { attempt.fail(error); resolve(); });
        res.on('aborted', () => { attempt.fail('response aborted'); resolve(); });
        if (res.statusCode === 200) b11Accepted++;
        else if (res.statusCode === 503) b11503Count++;
        else { b11Other++; b11OtherStatuses[res.statusCode] = (b11OtherStatuses[res.statusCode] ?? 0) + 1; }
        admissionChanged();
        res.resume();
        res.on('end', () => { attempt.end(); resolve(); });
      });
      req.on('error', (error) => { attempt.fail(error); b11Other++; b11OtherStatuses[error.code ?? 'error'] = (b11OtherStatuses[error.code ?? 'error'] ?? 0) + 1; admissionChanged(); connected(); resolve(); });
      req.setTimeout(15000, () => req.destroy(new Error('B11 request deadline')));
      req.on('socket', (socket) => {
        if (socket.connecting) socket.once('connect', connected);
        else connected();
      });
      req.write(JSON.stringify({
        model: 'gpt-5.6-sol',
        messages: [{ role: 'user', content: `b11-ceiling-${i}` }],
        stream: true,
      }));
      req.end();
    }));
    await bounded(socketReady, 'B11 socket');
    // TCP connect completes in the kernel accept queue before the gateway
    // accepts, and macOS caps that queue at 128 (kern.ipc.somaxconn); a busy
    // accept loop would overflow it and reset connections. So the next request
    // is sent only once this one is visibly settled: held at the upstream
    // mock, refused by admission, or failed. Concurrency is unchanged: every
    // admitted request stays held until releaseHold().
    await bounded(admitted, 'B11 admission observation');
  }

  const activeInMockPeak = activeInMock;
  const heldInFlight = await getInFlight(gwPort);
  if (activeInMock > 0 && heldInFlight < activeInMock) {
    earlyGateReleaseCount = activeInMock - heldInFlight;
  }

  const b11MidStats = await getProcessStats(gwProc.pid);
  evidence.raw.resources.push({ phase: 'B11', pid: gwProc.pid, observed_at: Date.now(), rss_bytes: b11MidStats.rssBytes, fd_count: b11MidStats.fds });
  evidence.event('B11', 'admission-peak', { active_in_mock: activeInMockPeak, in_flight: heldInFlight });
  releaseHold();
  await bounded(Promise.all(b11Promises), 'B11 responses');
  heldResponseDelayMs = 0;
  httpAgent.destroy();

  const b11DurationSecs = (Date.now() - b11Start) / 1000.0;
  const b11Rps = b11DurationSecs > 0 ? b11Accepted / b11DurationSecs : 0.0;
  const historyMemoryBounded = Boolean(b11MidStats.rssBytes !== null && b11MidStats.rssBytes < 512 * 1024 * 1024);

  const b11Report = {
    target_concurrency: b11TargetConcurrency,
    other_outcomes: b11OtherStatuses,
    held_in_mock_at_peak: activeInMockPeak,
    accepted_concurrency: b11Accepted,
    admission_503_count: b11503Count,
    early_gate_release_count: earlyGateReleaseCount,
    throughput_rps: Number(b11Rps.toFixed(1)),
    peak_rss_bytes: b11MidStats.rssBytes,
    peak_fds: b11MidStats.fds,
    history_memory_bounded: historyMemoryBounded,
  };

  await phase('B12');
  const b12ReloadCount = 5;
  let b12Errors = 0;
  const b12PauseTimes = [];
  let nextRequestUpdatedCount = 0;

  for (let i = 0; i < b12ReloadCount; i++) {
    const newAccountToken = `token-reloaded-${i}`;
    const newAccountAuth = {
      identity_slug: `reloaded-${i}`,
      access_token: newAccountToken,
      account_id: `reloaded-account-${i}`,
      email: `reloaded-${i}@example.invalid`,
      expired: '2099-01-01T00:00:00Z',
      id_token: `id-reloaded-${i}`,
      last_refresh: '2026-01-01T00:00:00Z',
      refresh_token: `rt-reloaded-${i}`,
      type: 'plus',
      upstream_override: mockOverride,
    };
    await writeFile(join(authDir, `codex-d-reloaded-${i}.json`), JSON.stringify(newAccountAuth, null, 2));
    evidence.event('B12', 'credential-write', { iteration: i, credential: newAccountAuth });

    if (i === 0) {
      try {
        await unlink(join(authDir, 'codex-b-acc1.json'));
        removedTokens.add('token-acc1');
      } catch {}
    } else {
      try {
        await unlink(join(authDir, `codex-d-reloaded-${i - 1}.json`));
        removedTokens.add(`token-reloaded-${i - 1}`);
      } catch {}
    }

    const tReload = Date.now();
    try {
      const reloadRes = await fetch(`http://127.0.0.1:${gwPort}/v0/management/auth-files/refresh?name=codex-d-reloaded-${i}.json`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${managementKey}`,
        },
      });
      evidence.event('B12', 'reload-response', { iteration: i, started_at: tReload, status: reloadRes.status, body: await reloadRes.text(), new_credential: newAccountToken, removed_credentials: [...removedTokens] });
      b12PauseTimes.push(Date.now() - tReload);
      if (!reloadRes.ok) {
        b12Errors++;
      }
    } catch (error) {
      evidence.event('B12', 'reload-error', { iteration: i, started_at: tReload, error: String(error) });
      b12Errors++;
    }

    try {
      const chatRes = await fetch(gwChatUrl, {
        method: 'POST',
        headers: requestHeaders(`b12-traffic-${i}`),
        body: JSON.stringify({
          model: 'gpt-5.6-sol',
          messages: [{ role: 'user', content: `b12-traffic-${i}` }],
          stream: true,
        }),
      });
      await chatRes.text();
      if (chatRes.status === 200 && usedCredential(mockExecutionLog, `b12-traffic-${i}`, newAccountToken)) {
        nextRequestUpdatedCount++;
      } else {
        b12Errors++;
      }
    } catch {
      b12Errors++;
    }
  }

  const b12AvgPause = b12PauseTimes.length > 0
    ? (b12PauseTimes.reduce((a, b) => a + b, 0) / b12PauseTimes.length)
    : null;

  const b12Report = {
    reload_during_traffic_count: b12ReloadCount,
    stale_credential_resurrections: removedTokensObserved.size,
    next_request_updated: nextRequestUpdatedCount === b12ReloadCount,
    pause_time_ms: b12AvgPause !== null ? Number(b12AvgPause.toFixed(1)) : null,
    errors_during_reload: b12Errors,
  };

  await phase('B13');
  const b13EventCount = 100;
  const b13Latencies = [];

  const b13Ids = Array.from({ length: b13EventCount }, (_, i) => `b13-telemetry-${i}`);
  await bounded(Promise.all(b13Ids.map(async id => {
    const t0 = Date.now();
    const r = await fetch(gwChatUrl, {
      method: 'POST', headers: requestHeaders(id),
      body: JSON.stringify({ model: 'gpt-5.6-sol', messages: [{ role: 'user', content: id }], stream: true }),
    });
    await r.text();
    if (!r.ok) throw new Error(`B13 HTTP ${r.status}`);
    b13Latencies.push(Date.now() - t0);
  })), 'B13 concurrent requests');
  await bounded(observations.wait(events => b13Ids.every(id =>
    correlatedLifecycle(events, requestBindings.get(id), 'recorded').length === 1)), 'B13 submitted records');

  b13Latencies.sort((a, b) => a - b);
  const b13P99 = nearestRankPercentile(b13Latencies, 99.0);

  // Authenticated existing read barrier drains the ingest queue before shutdown.
  // No new endpoint and no assumption that process exit flushes detached workers.
  const drainResponse = await fetch(`http://127.0.0.1:${gwPort}/v0/management/history/count`, {
    headers: { authorization: `Bearer ${managementKey}` },
  });
  const drainBody = await drainResponse.text();
  evidence.event('B13', 'history-drain', { status: drainResponse.status, body: drainBody });
  if (!drainResponse.ok) throw new Error(`history drain HTTP ${drainResponse.status}`);
  const preShutdownStats = await getProcessStats(gwProc.pid);

  evidence.raw.resources.push({ phase: 'B13', pid: gwProc.pid, observed_at: Date.now(), rss_bytes: preShutdownStats.rssBytes, fd_count: preShutdownStats.fds });
  gwProc.kill('SIGINT');
  const shutdownCode = await bounded(gwProc.exited, 'gateway graceful shutdown');
  await bounded(Promise.all(pipeDrains), 'gateway final observations');
  mockServer.stop(true);

  const sqlitePath = join(authDir, 'request-history.sqlite');
  const db = new Database(sqlitePath, { readonly: true });
  let rows;
  try { rows = db.query('SELECT event_id FROM usage_events').all(); }
  finally { db.close(); }
  evidence.event('B13', 'persisted-telemetry', { rows, shutdown_code: shutdownCode });
  const durable = durableObservations(observations.events, b13Ids.map(id => requestBindings.get(id)), rows);
  const b13Report = {
    telemetry_events_emitted: b13EventCount,
    ...durable,
    drain_mode: 'authenticated-pre-shutdown-barrier',
    drained_shutdown: shutdownCode === 0 && durable.drained_shutdown,
    suite_total_rows: rows.length,
    suite_duplicate_events: rows.length - new Set(rows.map(row => row.event_id)).size,
    p99_request_ms: Number(b13P99.toFixed(1)),
    peak_rss_bytes: preShutdownStats.rssBytes,
  };
  // Re-evaluate after both pipes drain so late duplicate lifecycle events fail.
  b10Report.guard_released_once_count = b10Ids.filter(id => exactCancellation(observations.events, requestBindings.get(id))).length;
  b10Report.abandoned_work_drained = b10Report.guard_released_once_count === b10AbortCount && b10Report.zombie_upstream_tasks === 0;
  b7Report.committed_replay_prevented = postcommitReplayPrevented(postcommit, mockExecutionLog);
  await phase('DONE');

  evidence.raw.lifecycle = observations.events;
  evidence.raw.phase_bindings = Object.fromEntries(requestBindings);
  const report = {
    suite: 'bench-resilience',
    matrix: 'B6-B7,B10-B13',
    timestamp: new Date().toISOString(),
    ports: { mock: mockPort, gateway: gwPort },
    b6_burst_refresh: b6Report,
    b7_scoped_limits: b7Report,
    b10_slow_client: b10Report,
    b11_concurrency_ceiling: b11Report,
    b12_config_reload: b12Report,
    b13_sqlite_telemetry: b13Report,
    correctness_passed: false,
    errors: { failed: [] },
    raw_observations: evidence.raw,
    observations: observations.events,
    phase_bindings: Object.fromEntries(requestBindings),
    upstream_executions: mockExecutionLog.map(({ authHeader, ...entry }) => ({ ...entry, credential_digest: createHash('sha256').update(authHeader).digest('hex') })),
  };

  report.errors.failed = resilienceFailures(report);
  report.correctness_passed = report.errors.failed.length === 0;
  const outFile = join(destination, 'resilience-report.json');
  await writeFile(outFile, JSON.stringify(report, null, 2));
  return report;
  } catch (error) {
    evidence.raw.failure = String(error?.message ?? error);
    throw error;
  } finally {
    try {
      if (gatewayChild) {
        if (gatewayChild.exitCode === null) gatewayChild.kill('SIGKILL');
        await bounded(gatewayChild.exited, 'gateway reap');
        await bounded(Promise.all(pipeDrains), 'gateway observation pipe drain');
      }
    } finally {
      try {
        evidence.raw.lifecycle = observations.events;
        evidence.raw.phase_bindings = Object.fromEntries(requestBindings);
        if (rawPath) await writeFile(rawPath, JSON.stringify(evidence.raw, null, 2));
      } finally { await owner.close(); }
    }
  }
}

export function observationJournal() {
  const events = [], subscribers = new Set();
  const add = event => {
    events.push(event);
    for (const subscriber of subscribers) subscriber();
  };
  return {
    events, add,
    line(line) {
      const clean = line.replace(/\x1b\[[0-9;]*m/g, '');
      const match = clean.match(/(?:history|cancel)_observation=(\{.*\})\s*$/);
      if (match) add(JSON.parse(match[1]));
      else if (/listening|server started/i.test(clean)) add({ event: 'listening' });
    },
    wait(predicate) {
      if (predicate(events)) return Promise.resolve();
      return new Promise(resolve => {
        const notify = () => { if (predicate(events)) { subscribers.delete(notify); resolve(); } };
        subscribers.add(notify);
      });
    },
  };
}

export function correlatedLifecycle(events, observationId, name) {
  const bindings = events.filter(event => event.event === 'request' && event.observation_id === observationId);
  if (!observationId || bindings.length !== 1) return [];
  return events.filter(event => event.event === name && event.request_id === bindings[0].event_id);
}

export function exactCancellation(events, observationId) {
  const names = ['guard-acquire', 'stream-open', 'guard-release', 'finalized', 'recorded'];
  const lifecycle = names.map(name => correlatedLifecycle(events, observationId, name));
  return lifecycle.every(items => items.length === 1)
    && lifecycle[3][0].status === 499
    && lifecycle.every((items, i) => i === 0 || events.indexOf(items[0]) > events.indexOf(lifecycle[i - 1][0]));
}

async function readCommitted(reader) {
  const decoder = new TextDecoder();
  let text = '';
  for (;;) {
    const chunk = await bounded(reader.read(), 'committed downstream content');
    if (chunk.done) return false;
    text += decoder.decode(chunk.value, { stream: true });
    if (text.includes('committed')) return true;
  }
}

export function postcommitReplayPrevented(faults, executions) {
  return faults.length > 0 && faults.every(fault => fault.committed && fault.failure_injected && fault.failure_observed
    && executions.filter(entry => entry.id === fault.id).length === 1);
}

export function durableObservations(events, observationIds, rows) {
  const bindings = observationIds.map(id => events.filter(event => event.event === 'request' && event.observation_id === id));
  const bound = observationIds.length > 0 && bindings.every(items => items.length === 1)
    && new Set(bindings.map(items => items[0]?.event_id)).size === observationIds.length;
  const ids = bound ? bindings.map(items => items[0].event_id) : [];
  const commits = ids.map(id => events.filter(event => event.event === 'commit' && event.event_ids.includes(id)));
  const validCommits = bound && commits.every(items => items.length === 1 && items[0].written === items[0].event_ids.length
    && items[0].rejected === 0 && Number.isFinite(items[0].write_ms) && items[0].write_ms >= 0
    && Number.isSafeInteger(items[0].queue_depth) && items[0].queue_depth >= 0);
  const rowCounts = ids.map(id => rows.filter(row => row.event_id === id).length);
  const flush = events.filter(event => event.event === 'flush').at(-1);
  const dropped = bound ? rowCounts.filter(count => count === 0).length : null;
  const duplicates = bound ? rowCounts.reduce((n, count) => n + Math.max(0, count - 1), 0) : null;
  const writeTimes = validCommits ? commits.map(items => items[0].write_ms).sort((a, b) => a - b) : [];
  return {
    event_ids: ids,
    duplicate_events: duplicates,
    dropped_rows: dropped,
    write_backlog: validCommits ? Math.max(...commits.map(items => items[0].queue_depth)) : null,
    p99_write_ms: validCommits ? nearestRankPercentile(writeTimes, 99) : null,
    drained_shutdown: Boolean(validCommits && dropped === 0 && duplicates === 0 && flush
      && events.indexOf(flush) > Math.max(...commits.map(items => events.indexOf(items[0])))
      && flush.queue_depth === 0 && flush.dropped === 0 && flush.failures === 0
      && Number.isSafeInteger(flush.enqueued) && flush.enqueued >= ids.length && flush.enqueued === flush.written),
  };
}

export function resilienceFailures(report) {
  const { b6_burst_refresh: b6, b7_scoped_limits: b7, b10_slow_client: b10,
    b11_concurrency_ceiling: b11, b12_config_reload: b12, b13_sqlite_telemetry: b13 } = report;
  return Object.entries({
    B6: b6.burst_size >= 100 && b6.exact_refresh_count === 1 && b6.replay_success_count === b6.burst_size && b6.disk_token_preserved,
    B7: b7.rate_limits_injected > 0 && b7.properly_scoped_cooling && b7.failover_budget_respected && b7.committed_replay_prevented,
    B10: b10.aborts_tested >= 100 && b10.held_in_flight >= b10.aborts_tested && b10.guard_released_once_count === b10.aborts_tested
      && b10.leaked_guards === 0 && b10.zombie_upstream_tasks === 0 && b10.abandoned_work_drained,
    B11: b11.accepted_concurrency === 512 && b11.admission_503_count === b11.target_concurrency - 512
      && b11.held_in_mock_at_peak === 512 && b11.early_gate_release_count === 0 && b11.history_memory_bounded && Object.keys(b11.other_outcomes).length === 0,
    B12: b12.stale_credential_resurrections === 0 && b12.next_request_updated && b12.errors_during_reload === 0,
    B13: b13.telemetry_events_emitted >= 100 && b13.event_ids.length === b13.telemetry_events_emitted
      && b13.duplicate_events === 0 && b13.dropped_rows === 0 && b13.drained_shutdown
      && Number.isFinite(b13.p99_write_ms) && Number.isSafeInteger(b13.write_backlog),
  }).filter(([, passed]) => !passed).map(([phase]) => phase);
}

export function noCommittedReplay(entries, prefix, expectedCount) {
  const committed = entries.filter(entry => entry.status === 200 && entry.id?.startsWith(prefix));
  return committed.length === expectedCount && new Set(committed.map(entry => entry.id)).size === expectedCount;
}

export function usedCredential(entries, id, token) {
  const matches = entries.filter(entry => entry.id === id);
  return matches.length === 1 && matches[0].status === 200 && matches[0].authHeader === `Bearer ${token}`;
}

if (import.meta.main) {
  runResilienceBenchmark()
    .then(r => console.log('Resilience benchmark finished:', r.matrix))
    .catch(err => {
      console.error(err);
      process.exitCode = 1;
    });
}
