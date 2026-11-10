import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export async function retainLocalityReport({ readReport, exitCode, output, evidence, finishPhases }) {
  let report = null;
  let reportError = null;
  try {
    report = JSON.parse(await readReport());
    if (!report || typeof report !== 'object' || Array.isArray(report)) throw new Error('locality report must be an object');
    // Keep the native pre-augmentation value: the returned report later points
    // at evidence.raw, and sharing this object would create a JSON cycle.
    evidence.raw.native_report = structuredClone(report);
  } catch (error) {
    report = null;
    reportError = String(error?.message ?? error);
    evidence.raw.native_report_error = reportError;
  }
  let phaseError = null;
  try { finishPhases(); } catch (error) { phaseError = String(error?.message ?? error); }
  evidence.raw.native_exit_code = exitCode;
  if (exitCode !== 0 || reportError || phaseError) {
    const failures = [exitCode !== 0 ? `bench locality failed (${exitCode}): ${output}` : null,
      reportError ? `native report unavailable: ${reportError}` : null, phaseError].filter(Boolean);
    const error = new Error(failures.join('; '));
    error.native_report = report;
    error.raw_observations = evidence.raw;
    evidence.raw.failure = error.message;
    throw error;
  }
  return report;
}

export function localityFailoverFault() {
  let bound = null;
  let injected = false;
  return ({ model, messages, credential }) => {
    if (model !== 'gpt-5.6-sol' || !credential) return false;
    const text = messages?.filter(message => message.role === 'user').map(message => message.content).join(' ') ?? '';
    const probe = text.includes('request_id=B4:2 ') && text.includes(' fault=bound-a');
    if (text.includes('request_id=B4:0 ') && bound === null) bound = credential;
    if (probe && credential === bound && !injected) { injected = true; return true; }
    return false;
  };
}

export function countAccountHops(turns) {
  return turns.reduce((count, turn, index) => count + (index > 0 && turn.account !== turns[index - 1].account ? 1 : 0), 0);
}

export async function bounded(promise, label, timeoutMs = 15000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} deadline`)), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

// Own allocations from their first successful acquisition, including failures
// before readiness. Drain pipes immediately, not after waiting for child exit.
export function benchmarkOwner() {
  const children = [], servers = [], drains = [], releases = [];
  return {
    spawn(argv, options, onLine) {
      const child = Bun.spawn(argv, options);
      children.push(child);
      let output = '';
      let ready;
      const listening = new Promise(resolve => { ready = resolve; });
      const childDrains = [];
      for (const [index, stream] of [child.stdout, child.stderr].entries()) if (stream?.getReader) {
        const task = (async () => {
          const decoder = new TextDecoder();
          let pending = '';
          for await (const bytes of stream) {
            const text = decoder.decode(bytes, { stream: true });
            output = (output + text).slice(-65536);
            if (/listening|server started/i.test(output)) ready();
            if (onLine) {
              pending += text;
              const lines = pending.split('\n');
              pending = lines.pop();
              for (const line of lines) await onLine(line, index === 0 ? 'stdout' : 'stderr', child);
              if (pending.length > 65536) throw new Error('benchmark output line exceeds limit');
            }
          }
          if (onLine && pending) throw new Error('unterminated benchmark output line');
        })();
        childDrains.push(task);
        drains.push(task);
        task.catch(() => {}); // cleanup awaits and reports the original failure
      }
      const drained = Promise.all(childDrains);
      drained.catch(() => {});
      return { child, listening, drained, output: () => output };
    },
    serve(options) { const server = Bun.serve(options); servers.push(server); return server; },
    release(fn) { releases.push(fn); },
    async close() {
      const errors = [];
      for (const release of releases) try { release(); } catch (error) { errors.push(error); }
      for (const child of children) try { if (child.exitCode === null) child.kill('SIGKILL'); } catch (error) { errors.push(error); }
      for (const server of servers) try { await server.stop(true); } catch (error) { errors.push(error); }
      const results = await Promise.allSettled([...children.map(child => bounded(child.exited, 'child reap')), ...drains.map(task => bounded(task, 'pipe drain'))]);
      errors.push(...results.filter(result => result.status === 'rejected').map(result => result.reason));
      if (errors.length) throw new AggregateError(errors, 'benchmark cleanup failed');
    },
  };
}

export function localityPhaseCollector({ pid, evidence, measure, acknowledge, wall = () => Date.now() }) {
  const phases = ['B3', 'B4', 'B5', 'B8', 'B9'];
  let index = 0;
  return {
    async line(line, stream, child) {
      if (stream !== 'stderr' || !line.startsWith('MAHOQUOT_BENCH_PHASE ')) return;
      try {
        const marker = JSON.parse(line.slice('MAHOQUOT_BENCH_PHASE '.length));
        if (marker.event !== 'entered' || marker.pid !== pid || marker.phase !== phases[index]) throw new Error('invalid locality phase entry identity/order');
        const received = wall();
        evidence.event(marker.phase, 'phase-entry', { pid, marker_received_at: received });
        const stats = await measure(pid);
        const errors = [];
        if (stats.rssBytes === null) errors.push('gateway RSS measurement unavailable');
        if (stats.fds === null) errors.push('gateway descriptor measurement unavailable');
        evidence.raw.resources.push({ phase: marker.phase, pid, marker_received_at: received, observed_at: wall(),
          sample_kind: 'held-phase-entry', rss_bytes: stats.rssBytes, fd_count: stats.fds, errors });
        await acknowledge(`MAHOQUOT_BENCH_PHASE_ACK ${JSON.stringify({ phase: marker.phase, pid })}\n`, child);
        index++;
      } catch (error) {
        evidence.event(null, 'phase-protocol-error', { line, error: String(error?.message ?? error) });
        throw error;
      }
    },
    finish() {
      const missing = phases.slice(index);
      evidence.raw.phase_resource_support = { complete: missing.length === 0, missing_phases: missing };
      if (missing.length) throw new Error(`locality phase resource observations unavailable: ${missing.join(',')}`);
    },
  };
}

export function benchmarkFetch(input, init = {}) {
  const deadline = AbortSignal.timeout(15000);
  return globalThis.fetch(input, { ...init, proxy: '', signal: init.signal ? AbortSignal.any([init.signal, deadline]) : deadline });
}
function findFreePort(start = 18870, end = 18895) {
  for (let port = start; port <= end; port++) {
    try {
      const probe = Bun.listen({ hostname: '127.0.0.1', port, socket: { data() {} } });
      probe.stop(true);
      return port;
    } catch {}
  }
  throw new Error(`no free port found in range ${start}..${end}`);
}

/// Management credential for the gateway under test. The current gateway takes
/// only the dedicated management secret (Task 26); a pre-Task-26 baseline
/// gates management with the inference master key instead.
function managementAuth(env) {
  return env.BENCH_MGMT_AUTH === 'master'
    ? { authorization: 'Bearer benchkey' }
    : { authorization: 'Bearer mgmt-secret' };
}

export function phaseObservations({ clock = () => performance.now(), wall = () => Date.now() } = {}) {
  const raw = { schema: 'mahoquot/phase-observations-v1', requests: [], resources: [], events: [] };
  let sequence = 0;
  const event = (phase, name, fields = {}) => raw.events.push({ ...fields, event: name, phase, observed_at: wall() });
  const begin = (phase, logicalId = null) => {
    const start = clock();
    const row = { request_id: `${phase}-${++sequence}`, logical_id: logicalId, phase, started_at: wall(), headers_ms: null, content_ms: null, end_ms: null, error: null, status: null, response_body: '' };
    raw.requests.push(row);
    let pending = '';
    const decoder = new TextDecoder();
    return {
      row,
      headers(status) { row.status = status; row.headers_ms = clock() - start; },
      chunk(bytes) {
        const text = decoder.decode(bytes, { stream: true });
        row.response_body += text;
        pending += text;
        const lines = pending.split('\n');
        pending = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          let data;
          try { data = JSON.parse(line.slice(5).trim()); } catch { continue; }
          const content = data.choices?.[0]?.delta?.content ?? (data.type === 'response.output_text.delta' ? data.delta : null);
          if (typeof content === 'string' && content.length > 0 && row.content_ms === null) row.content_ms = clock() - start;
        }
      },
      end() { row.response_body += decoder.decode(); row.end_ms = clock() - start; },
      fail(error) { row.error = String(error?.message ?? error); row.end_ms = clock() - start; },
    };
  };
  const observeFetch = (transport, identify) => async (input, init = {}) => {
    const identity = identify(input, init);
    if (!identity) return transport(input, init);
    const attempt = begin(identity.phase, identity.id);
    const aborted = () => attempt.fail(init.signal.reason ?? 'request aborted');
    init.signal?.addEventListener('abort', aborted, { once: true });
    const unsubscribe = () => init.signal?.removeEventListener('abort', aborted);
    event(identity.phase, 'client-request', { request_id: attempt.row.request_id, logical_id: identity.id ?? null, url: String(input), body: init.body ?? null });
    try {
      const response = await transport(input, init);
      attempt.headers(response.status);
      if (!response.body) { attempt.end(); unsubscribe(); return response; }
      const reader = response.body.getReader();
      return new Response(new ReadableStream({
        async pull(controller) {
          try {
            const { value, done } = await reader.read();
            if (done) { attempt.end(); unsubscribe(); controller.close(); }
            else { attempt.chunk(value); controller.enqueue(value); }
          } catch (error) { attempt.fail(error); unsubscribe(); controller.error(error); }
        },
        async cancel(reason) { attempt.fail(reason ?? 'client cancelled'); unsubscribe(); await reader.cancel(reason); },
      }), { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (error) { attempt.fail(error); unsubscribe(); throw error; }
  };
  return { raw, event, begin, observeFetch };
}

export async function runLocalityBenchmark(env = process.env) {
  const owner = benchmarkOwner();
  const evidence = phaseObservations();
  let rawPath;
  const fetch = evidence.observeFetch(benchmarkFetch, (input, init) => {
    if (!String(input).includes('/v1/chat/completions') || typeof init.body !== 'string') return null;
    const body = JSON.parse(init.body);
    const id = body.x_bench_req;
    return id?.startsWith('b8-') ? { phase: 'B8', id } : null;
  });
  try {
  const targetDir = env.CARGO_TARGET_DIR ?? join(root, '.omo/shared-target');
  const bench = env.BENCH ?? join(targetDir, 'debug/bench');
  // Always rebuild (incremental): an existing binary may predate the bench
  // sources under test, and a stale tool must not stand in for the current one.
  if (!env.BENCH) {
    const buildRun = owner.spawn(['cargo', 'build', '-p', 'bench'], {
      cwd: join(root, 'mahoquot-proxy'),
      env: { ...process.env, ...env, CARGO_TARGET_DIR: targetDir },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const status = await bounded(buildRun.child.exited, 'bench build', 120000);
    if (status !== 0) throw new Error(`failed to build bench binary (${status}): ${buildRun.output()}`);
    if (!await Bun.file(bench).exists()) throw new Error(`bench build did not create ${bench}`);
  }

  const gateway = env.GWBIN ?? (
    env.MAHOQUOT_QA_EVIDENCE_ROOT
      ? join(env.MAHOQUOT_QA_EVIDENCE_ROOT, 'target/debug/mahoquot-gateway')
      : (await Bun.file(join(root, '.omo/shared-target/debug/mahoquot-gateway')).exists()
          ? join(root, '.omo/shared-target/debug/mahoquot-gateway')
          : join(root, 'mahoquot-proxy/target/debug/mahoquot-gateway'))
  );

  const mockPort = Number(env.MOCK_PORT ?? findFreePort(18870, 18875));
  const gwPort = Number(env.GW_PORT ?? findFreePort(mockPort + 1, 18885));
  const proxyPort = Number(env.PROXY_PORT ?? findFreePort(gwPort + 1, 18895));

  if (mockPort < 18840 || mockPort > 18899 || gwPort < 18840 || gwPort > 18899 || proxyPort < 18840 || proxyPort > 18899) {
    throw new Error('benchmark requires leased numeric loopback ports between 18840 and 18899');
  }

  const destination = resolve(env.BENCH_EVIDENCE ?? join(root, '.omo/evidence', `bench-locality-${randomUUID()}`));
  await mkdir(destination, { recursive: true });
  rawPath = join(destination, 'locality-raw.json');

  const authDir = join(destination, 'auth');
  await mkdir(authDir, { recursive: true });

  // Real fault injection flags for testing failure detection from observed data
  const injectWrongEgress = env.BENCH_FAULT_EGRESS === 'true';
  const injectTenantCollision = env.BENCH_FAULT_COLLISION === 'true';

  // Observed statistics tracked at mock and proxy listener
  const connectionCounts = new Map(); // remotePort -> request count
  const connectionAccounts = new Map(); // remotePort -> first account auth seen
  let uniqueConnections = 0;
  let connectionReuses = 0;
  let crossAccountLeaks = 0;
  let handshakeErrorCount = 0;

  // Track B3/B4/B5 metrics observed directly at upstream mock
  const upstreamRequests = [];
  let leakedRoutingHeadersCount = 0;
  let signatureRecallCount = 0;
  let observedTenantCollisions = 0;
  const observedTurns = [];
  const workloadExecutions = [];
  evidence.raw.workload_executions = workloadExecutions;
  const failoverFault = localityFailoverFault();

  const b8Hops = []; // records each gateway request: { hop: 'proxy' | 'direct', expected, path }
  const b8HopLog = []; // Per-request hop log: { request_id, timestamp, passed_loopback_proxy, reached_mock_directly, config_generation }
  const proxySeenReqIds = new Set();
  let proxyListenerHits = 0;
  let currentConfigGeneration = 1;
  let inflightIntactObserved = false;
  let nextRequestCorrectEgressObserved = false;
  let releaseInflight;
  const inflightRelease = new Promise(resolve => { releaseInflight = resolve; });
  owner.release(() => releaseInflight());

  // 1. Mock server on mockPort
  owner.serve({
    hostname: '127.0.0.1',
    port: mockPort,
    async fetch(request, server) {
      const url = new URL(request.url);

      if (url.pathname === '/_mock/stats') {
        const proxyHops = b8Hops.filter(h => h.hop === 'proxy').length;
        const directHops = b8Hops.filter(h => h.hop === 'direct').length;
        const fallbacks = b8Hops.filter(h => h.expected === 'proxy' && h.hop === 'direct').length;

        // Read effective settings from gateway management API
        let idleTimeoutSecs;
        let maxIdlePerHost;
        try {
          const cfgRes = await fetch(`http://127.0.0.1:${gwPort}/v0/management/config`, {
            headers: managementAuth(env),
            proxy: '',
          });
          if (cfgRes.ok) {
            const cfg = await cfgRes.json();
            const antigravity = cfg.antigravity ?? cfg;
            if (typeof antigravity.idle_timeout_secs === 'number') idleTimeoutSecs = antigravity.idle_timeout_secs;
            if (typeof antigravity.max_idle_per_host === 'number') maxIdlePerHost = antigravity.max_idle_per_host;
          }
        } catch { /* Unsupported config endpoint: omit unobserved settings. */ }

        const stats = {
          total_requests: b8Hops.length,
          proxy_hops: proxyHops,
          direct_hops: directHops,
          direct_fallback_count: fallbacks,
          connection_churn_count: uniqueConnections,
          connection_reuse_count: connectionReuses,
          cross_account_leaks: crossAccountLeaks,
          handshake_error_count: handshakeErrorCount,
          global_proxy_url: `http://127.0.0.1:${proxyPort}`,
          per_provider_proxy_url: `http://127.0.0.1:${proxyPort}`,
          next_request_correct_egress: nextRequestCorrectEgressObserved,
          inflight_intact: inflightIntactObserved,
          hop_log: b8HopLog,
          ...(idleTimeoutSecs === undefined ? {} : { idle_timeout_secs: idleTimeoutSecs }),
          ...(maxIdlePerHost === undefined ? {} : { max_idle_per_host: maxIdlePerHost }),
          // B3-B5 observed metrics
          upstream_requests_count: upstreamRequests.length,
          raw_routing_headers_leaked: observedTurns.filter(turn => turn.routing_headers_leaked).length,
          signature_recall_success: observedTurns.filter(turn => turn.phase === 'b3').slice(1).every(turn => turn.signature_present),
          cross_tenant_collisions: observedTurns.filter(turn => turn.phase === 'b5' && turn.tenant !== turn.requested_tenant).length,
          observed_turns: observedTurns,
          workload_executions: workloadExecutions,
          rebind_count: countAccountHops(observedTurns.filter(turn => turn.phase === 'b3')),
          hops: observedTurns.filter(turn => turn.phase === 'b3').length,
          account_hops: countAccountHops(observedTurns.filter(turn => turn.phase === 'b4')),
          independent_binding_retained: new Set(observedTurns.filter(turn => turn.phase === 'b4').map(turn => turn.account)).size <= 2,
          initial_binding_account: observedTurns.find(turn => turn.phase === 'b3')?.account ?? '',
          route_a_account: observedTurns.find(turn => turn.phase === 'b4')?.account ?? '',
          route_b_account: observedTurns.filter(turn => turn.phase === 'b4')[1]?.account ?? '',
        };
        return Response.json(stats);
      }

      if (url.pathname === '/v1/models') {
        return Response.json({
          object: 'list',
          data: [
            { id: 'gpt-5.6-sol', object: 'model', owned_by: 'openai' },
            { id: 'claude-sonnet-4', object: 'model', owned_by: 'anthropic' },
            { id: 'egress-proxy-model', object: 'model', owned_by: 'openai' },
            { id: 'egress-direct-model', object: 'model', owned_by: 'openai' },
            { id: 'antigravity-model', object: 'model', owned_by: 'antigravity' },
          ]
        });
      }

      // Track connection reuse & cross-account leaks via client TCP socket port
      const peer = server?.requestIP?.(request);
      const connectionId = peer ? `${peer.address}:${peer.port}` : undefined;
      const authHeader = request.headers.get('authorization') ?? '';
      const accountForObservation = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
      const relayedByBenchProxy = request.headers.get('x-bench-hop') === 'proxy';
      if (connectionId && !relayedByBenchProxy) {
        const prev = connectionCounts.get(connectionId) ?? 0;
        if (prev === 0) {
          uniqueConnections++;
          connectionAccounts.set(connectionId, authHeader);
        } else {
          connectionReuses++;
          const initialAuth = connectionAccounts.get(connectionId);
          if (initialAuth !== authHeader) {
            crossAccountLeaks++;
          }
        }
        connectionCounts.set(connectionId, prev + 1);
      }

      const bodyText = await request.text();
      let bodyJson = {};
      try { bodyJson = JSON.parse(bodyText); } catch {}

      // Identify request ID from header or body marker
      const reqId = request.headers.get('x-bench-req')
        ?? bodyJson['x-bench-req']
        ?? bodyJson.x_bench_req
        ?? (typeof bodyJson.messages?.[0]?.content === 'string' && bodyJson.messages[0].content.startsWith('b8 ')
            ? bodyJson.messages[0].content
            : undefined);

      const isViaProxy = request.headers.get('x-bench-hop') === 'proxy'
        || request.headers.has('via')
        || (reqId ? proxySeenReqIds.has(reqId) : false);
      const hop = isViaProxy ? 'proxy' : 'direct';

      if (reqId) {
        b8HopLog.push({
          request_id: reqId,
          timestamp: new Date().toISOString(),
          passed_loopback_proxy: isViaProxy,
          reached_mock_directly: !isViaProxy,
          config_generation: currentConfigGeneration,
        });
      }

      const messageText = JSON.stringify(bodyJson.messages ?? []);
      const isTenant2Collision = messageText.includes('tenant2 collision probe intent');
      const phase = request.headers.get('x-bench-phase') ?? (isTenant2Collision ? 'b5'
        : messageText.includes('history context and signatures') ? 'b3'
          : bodyJson.model?.startsWith('b4-route-') || messageText.includes('alternating route test') ? 'b4'
            : messageText.includes('parent root intent') || messageText.includes('child subagent execution') ? 'b5'
              : undefined);
      const turnNumber = Number(request.headers.get('x-bench-turn')) || (phase === 'b3'
        ? upstreamRequests.filter(item => item.phase === 'b3').length + 1
        : phase === 'b4'
          ? upstreamRequests.filter(item => item.phase === 'b4').length + 1
          : phase === 'b5'
            ? upstreamRequests.filter(item => item.phase === 'b5').length + 1
            : 0);
        const requestedTenant = request.headers.get('x-bench-tenant') ?? (isTenant2Collision ? 'tenant2' : 'tenant1');

      // Retain the actual wire body and socket before any rejection path.
      const workloadId = messageText.match(/request_id=(B(?:4|5|9):\d+)/)?.[1] ?? null;
      const rawPhase = phase?.toUpperCase() ?? (messageText.includes('b9 antigravity') ? 'B9' : reqId ? 'B8' : null);
      const recordExecution = status => {
        if (request.headers.get('x-bench-phase') === 'pooling-calibration' || !['B4', 'B5', 'B9'].includes(rawPhase)) return;
        workloadExecutions.push({ phase: rawPhase, request_id: workloadId ?? (rawPhase === 'B5' ? `B5:${turnNumber - 1}` : null),
          account: accountForObservation || null, connection_id: relayedByBenchProxy ? null : connectionId ?? null, status });
      };
      evidence.event(rawPhase, 'upstream-request', {
        request_id: reqId ?? null, turn: turnNumber || null,
        phase_header: request.headers.get('x-bench-phase'), turn_header: request.headers.get('x-bench-turn'), tenant_header: request.headers.get('x-bench-tenant'),
        body: bodyJson, body_text: bodyText, path: url.pathname,
        credential: accountForObservation || null, connection_id: connectionId ?? null,
        proxy_listener: isViaProxy ? `127.0.0.1:${proxyPort}` : null,
        via: request.headers.get('via'), config_generation: currentConfigGeneration,
        routing_headers: { session: request.headers.get('x-session-id'), client_request: request.headers.get('x-client-request-id') },
        requested_tenant: requestedTenant,
        calibration: request.headers.get('x-bench-phase') === 'pooling-calibration',
      });

      // Track routing headers leaked upstream
      const routingHeadersLeaked = request.headers.has('x-session-id') || request.headers.has('x-client-request-id');
      if (routingHeadersLeaked) {
        leakedRoutingHeadersCount++;
        recordExecution(400);
        return new Response('routing header leaked upstream', { status: 400 });
      }

      // Track signature replay in upstream request body
      const signaturePresent = Array.isArray(bodyJson.messages) && bodyJson.messages.some((message) =>
        message?.role === 'assistant' && typeof message.content === 'string' && message.content.length > 0);
      if (phase === 'b3' && signaturePresent) signatureRecallCount++;

      // Record upstream request for verification
      upstreamRequests.push({
        path: url.pathname,
        phase,
        auth: authHeader,
        model: bodyJson.model,
        connectionId,
        sessionId: request.headers.get('x-session-id') ?? '',
        tenant: accountForObservation,
        messageRoles: Array.isArray(bodyJson.messages) ? bodyJson.messages.map((message) => message?.role) : [],
      });

      if (phase && turnNumber > 0) {
        const tenant = accountForObservation === 'key-tenant-1-proxy' ? 'tenant1' : accountForObservation === 'key-tenant-2-direct' ? 'tenant2' : 'unknown';
        observedTurns.push({
          phase,
          turn: turnNumber,
          account: accountForObservation || 'missing-account-binding',
          routing_headers_leaked: routingHeadersLeaked,
          signature_present: signaturePresent,
          tenant,
          requested_tenant: requestedTenant,
        });
      }

      // Track cross-tenant collision:
      // If tenant 2's request (identified by tenant2 intent or expected binding) uses tenant 1's upstream credential
      if (phase === 'b5' && requestedTenant === 'tenant2') {
        const boundTenant = accountForObservation === 'key-tenant-1-proxy' ? 'tenant1' : accountForObservation === 'key-tenant-2-direct' ? 'tenant2' : 'unknown';
        if (boundTenant !== requestedTenant) observedTenantCollisions++;
      }

      // Only track gateway requests in b8Hops (skip direct pooling calibration probes)
      const isPoolingProbe = request.headers.get('x-bench-phase') === 'pooling-calibration';
      if (!isPoolingProbe && bodyJson.model?.startsWith('egress-')) {
        const configuredHop = currentConfigGeneration >= 2 && !injectWrongEgress ? 'direct' : 'proxy';
        const expectedHop = bodyJson.model === 'egress-direct-model' ? 'direct' : configuredHop;
        b8Hops.push({
          hop,
          expected: expectedHop,
          model: bodyJson.model,
          message: bodyJson.messages?.[0]?.content,
          path: url.pathname,
          observed_at: new Date().toISOString(),
        });
      }

      if (failoverFault({ model: bodyJson.model, messages: bodyJson.messages, credential: accountForObservation })) {
        recordExecution(503);
        evidence.event('B4', 'upstream-fault', { request_id: reqId ?? null, credential: accountForObservation, model: bodyJson.model, body: bodyJson, status: 503 });
        return Response.json({ error: { message: 'b4 correlated failover fault', type: 'server_error' } }, { status: 503 });
      }
      recordExecution(200);
      evidence.event(rawPhase, 'upstream-response', { request_id: reqId ?? null, credential: accountForObservation, model: bodyJson.model, status: 200 });

      const expectedInput = bodyJson.bench_expect?.input_tokens ?? 16;
      const expectedOutput = bodyJson.bench_expect?.output_tokens ?? 2;

      const frames = [
        'data: {"choices":[{"delta":{"content":"x"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"x"}}]}\n\n',
        `data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":${expectedInput},"completion_tokens":${expectedOutput},"total_tokens":${expectedInput + expectedOutput}}}\n\n`,
        'data: [DONE]\n\n'
      ];

      evidence.event(rawPhase, 'fixture-response', { request_id: reqId ?? null, turn: turnNumber || null, body: frames.join('') });
      // For in-flight streaming requests, use ReadableStream with small chunk delay to ensure in-flight status during management call
      const isInflightStreamProbe = reqId && reqId.includes('inflight');
      if (isInflightStreamProbe) {
        const stream = new ReadableStream({
          async start(controller) {
            const encoder = new TextEncoder();
            controller.enqueue(encoder.encode(frames[0]));
            // Pause while client receives first chunk and fires management update
            await bounded(inflightRelease, 'in-flight management release');
            for (let i = 1; i < frames.length; i++) {
              controller.enqueue(encoder.encode(frames[i]));
            }
            controller.close();
          }
        });

        return new Response(stream, {
          headers: {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            'connection': 'keep-alive',
          }
        });
      }

      return new Response(frames.join(''), {
        headers: {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          'connection': 'keep-alive',
        }
      });
    }
  });

  // 2. Loopback proxy listener on proxyPort
  owner.serve({
    hostname: '127.0.0.1',
    port: proxyPort,
    error(err) {
      handshakeErrorCount++;
    },
    async fetch(req) {
      if (req.method === 'CONNECT') {
        return new Response(null, { status: 200 });
      }
      proxyListenerHits++;
      evidence.event(null, 'proxy-request', { url: req.url, method: req.method, request_id: req.headers.get('x-bench-req') });
      const targetUrl = new URL(req.url);
      targetUrl.host = `127.0.0.1:${mockPort}`;
      targetUrl.protocol = 'http:';

      const headers = new Headers(req.headers);
      headers.set('x-bench-hop', 'proxy');
      headers.set('via', '1.1 bench-locality-proxy');

      const body = req.method !== 'GET' && req.method !== 'HEAD' ? await req.arrayBuffer() : undefined;
      if (body) {
        try {
          const bodyStr = new TextDecoder().decode(body);
          const parsed = JSON.parse(bodyStr);
          const proxyReqId = req.headers.get('x-bench-req') ?? parsed['x-bench-req'] ?? parsed.x_bench_req;
          if (proxyReqId) proxySeenReqIds.add(proxyReqId);
        } catch {}
      }
      try {
        return await fetch(targetUrl.toString(), {
          method: req.method,
          headers,
          body,
          proxy: '',
        });
      } catch (e) {
        handshakeErrorCount++;
        throw e;
      }
    }
  });

  // 3. Configure gateway accounts and settings
  // Account 1: Omits credential-level proxy_url so it dynamically follows the gateway's global proxy-url setting
  const proxyAccount = {
    type: 'generic',
    identity_slug: 'proxy-account',
    provider: 'openai',
    adapter: 'openai-chat',
    api_key: 'key-tenant-1-proxy',
    models: ['gpt-5.6-sol', 'claude-sonnet-4', 'egress-proxy-model'],
    base_url: `http://127.0.0.1:${mockPort}/v1`,
    upstream_override: `http://127.0.0.1:${mockPort}`,
  };
  await writeFile(join(authDir, 'generic-proxy.json'), JSON.stringify(proxyAccount, null, 2));

  // Account 2: Routes direct (no proxy)
  const directAccount = {
    type: 'generic',
    identity_slug: 'direct-account',
    provider: 'openai',
    adapter: 'openai-chat',
    api_key: 'key-tenant-2-direct',
    models: ['gpt-5.6-sol', 'egress-direct-model'],
    base_url: `http://127.0.0.1:${mockPort}/v1`,
    upstream_override: `http://127.0.0.1:${mockPort}`,
    proxy_url: 'direct',
  };
  await writeFile(join(authDir, 'generic-direct.json'), JSON.stringify(directAccount, null, 2));

  const failoverAccounts = [
    ['b4-a-primary', 'gpt-5.6-sol'], ['b4-a-alternate', 'gpt-5.6-sol'], ['b4-b', 'claude-sonnet-4'],
  ].map(([identity, model]) => ({ ...directAccount, provider: 'b4-fixture', identity_slug: identity, api_key: `key-${identity}`, models: [model] }));
  for (const [index, account] of failoverAccounts.entries()) {
    await writeFile(join(authDir, `generic-b4-${index}.json`), JSON.stringify(account, null, 2));
  }
  const b4KeyHash = createHash('sha256').update('b4key').digest('hex');
  const tenant1KeyHash = createHash('sha256').update('benchkey').digest('hex');
  const tenant2KeyHash = createHash('sha256').update('tenant2key').digest('hex');

  // Initial proxy setting: starts at loopback proxy (generation 1)
  const initialProxyUrl = `http://127.0.0.1:${proxyPort}`;

  const gwConfig = `
routing:
  strategy: fill-first
  session-affinity: true
request-retry: 2
max-retry-credentials: 2
usage-statistics-enabled: false
model-catalog:
  refresh-enabled: false
remote-management:
  secret-key: mgmt-secret
api-keys:
  - benchkey
  - tenant2key
  - b4key
api-key-bindings:
  - key_identifier: "${b4KeyHash}"
    provider: "b4-fixture"
  - key_identifier: "${tenant1KeyHash}"
    account: "proxy-account"
  - key_identifier: "${tenant2KeyHash}"
    account: "${injectTenantCollision ? 'proxy-account' : 'direct-account'}"
proxy-url: "${initialProxyUrl}"
`;
  await writeFile(join(authDir, 'config.yaml'), gwConfig);
  evidence.event(null, 'routing-config', { yaml: gwConfig, accounts: [proxyAccount, directAccount, ...failoverAccounts] });

  // 4. Launch gateway process
  const gatewayRun = owner.spawn([
    gateway,
    'serve',
    '--bind', '127.0.0.1',
    '--port', String(gwPort),
    '--auth-dir', authDir,
    '--auth-refresh', 'false',
    '--log-level', 'info'
  ], {
    env: {
      ...process.env,
      MAHOQUOT_QA_LOOPBACK_ONLY: '1',
      HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '',
      API_KEYS: 'benchkey,tenant2key,b4key',
      MANAGEMENT_PASSWORD: 'mgmt-secret',
      USAGE_POLL_SECS: '3600',
      MAX_FAILOVER: '2',
    },
    stdout: 'ignore',
    stderr: 'pipe',
  });

  const gwProc = gatewayRun.child;
  await bounded(Promise.race([gatewayRun.listening, gwProc.exited.then(code => { throw new Error(`gateway exited before readiness: ${code}`); })]), 'gateway readiness');
  const health = await fetch(`http://127.0.0.1:${gwPort}/healthz`);
  if (!health.ok) throw new Error(`gateway health status ${health.status}`);
  await health.text();

  // Helper: changes proxy-url via gateway management API using dedicated management secret
  async function updateProxySettingViaManagement(newProxy) {
    const getRes = await fetch(`http://127.0.0.1:${gwPort}/v0/management/config.yaml`, {
      headers: managementAuth(env),
      proxy: '',
    });
    if (!getRes.ok) {
      throw new Error(`failed to read config.yaml via management API (${getRes.status}): ${await getRes.text()}`);
    }
    const yaml = await getRes.text();
    const updatedYaml = yaml.includes('proxy-url:')
      ? yaml.replace(/proxy-url:\s*.*$/m, `proxy-url: "${newProxy}"`)
      : `${yaml}\nproxy-url: "${newProxy}"\n`;

    const putRes = await fetch(`http://127.0.0.1:${gwPort}/v0/management/config.yaml`, {
      method: 'PUT',
      headers: {
        ...managementAuth(env),
        'content-type': 'application/yaml',
      },
      body: updatedYaml,
      proxy: '',
    });
    if (!putRes.ok) {
      throw new Error(`failed to update proxy setting via management API (${putRes.status}): ${await putRes.text()}`);
    }
    const result = await putRes.json();
    evidence.event('B8', 'config-update', { yaml: updatedYaml, status: putRes.status, response: result });
    return result;
  }

  // Verification step for B8:
  // (1) Start streaming request in-flight through proxy (generation 1)
  const inflightReqId = 'b8-req-1-inflight-stream';
  const inflightRes = await fetch(`http://127.0.0.1:${gwPort}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': 'Bearer benchkey',
      'x-bench-req': inflightReqId,
    },
    body: JSON.stringify({
      model: 'egress-proxy-model',
      messages: [{ role: 'user', content: 'b8-inflight-proxy-request' }],
      stream: true,
      x_bench_req: inflightReqId,
      bench_expect: { text: 'xx', input_tokens: 16, output_tokens: 2 }
    }),
    proxy: '',
  });

  if (!inflightRes.ok) {
    throw new Error(`b8 inflight request failed with status ${inflightRes.status}`);
  }

  // Read first stream chunk to prove the streaming connection is actively in flight
  const inflightReader = inflightRes.body.getReader();
  const firstChunk = await inflightReader.read();
  const chunkTextDecoder = new TextDecoder();
  let inflightBodyText = chunkTextDecoder.decode(firstChunk.value ?? new Uint8Array());
  if (!firstChunk.done && firstChunk.value) evidence.event('B8', 'inflight-consumed', { logical_id: inflightReqId, body: inflightBodyText });

  // (2) WHILE the streaming request is in flight, change proxy setting via management API
  // In happy path: switch proxy-url to "direct" (new hop for generation 2)
  // In failure variant: inject wrong egress for real (keep proxy or set invalid egress so generation 2 uses wrong hop)
  const nextTargetProxy = injectWrongEgress ? `http://127.0.0.1:${proxyPort}` : 'direct';
  await updateProxySettingViaManagement(nextTargetProxy);
  currentConfigGeneration = 2;
  releaseInflight();
  const managementCallReturnedAt = Date.now();

  // (3) Issue Request 2: the first request STARTED AFTER the management call returned
  const afterSwitchReqId = 'b8-req-2-after-switch';
  const reqDirectPromise = fetch(`http://127.0.0.1:${gwPort}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': 'Bearer benchkey',
      'x-bench-req': afterSwitchReqId,
    },
    body: JSON.stringify({
      model: 'egress-proxy-model',
      messages: [{ role: 'user', content: 'b8-after-switch-request' }],
      stream: true,
      x_bench_req: afterSwitchReqId,
      bench_expect: { text: 'xx', input_tokens: 16, output_tokens: 2 }
    }),
    proxy: '',
  });

  // Finish draining in-flight stream and assert it completed intact
  while (true) {
    const { value, done } = await inflightReader.read();
    if (done) break;
    inflightBodyText += chunkTextDecoder.decode(value);
  }
  inflightIntactObserved = inflightRes.status === 200 && inflightBodyText.includes('[DONE]');

  // Await completion of request started after management call
  const reqDirectRes = await reqDirectPromise;
  const reqDirectText = await reqDirectRes.text();
  const reqDirectOk = reqDirectRes.status === 200 && reqDirectText.includes('[DONE]');

  // Evaluate next_request_correct_egress from the hop log:
  // Must verify the first request started after management call returned uses the new hop (direct),
  // not requests issued before it
  const inflightHop = b8HopLog.find(h => h.request_id === inflightReqId);
  const afterSwitchHop = b8HopLog.find(h => h.request_id === afterSwitchReqId);

  if (!inflightHop || !afterSwitchHop) {
    throw new Error('b8 hop log missing required in-flight or post-switch observations (hard error)');
  }

  // Expected: in-flight used proxy, post-switch uses direct (when not fault-injected)
  const afterSwitchHopCorrect = afterSwitchHop.reached_mock_directly && !afterSwitchHop.passed_loopback_proxy;
  nextRequestCorrectEgressObserved = reqDirectOk && inflightIntactObserved && (injectWrongEgress ? !afterSwitchHopCorrect : afterSwitchHopCorrect);

  // Verification step for B9:
  // Measure pooling on vs off:
  // Off: requests sent with Connection: close
  const reuseBefore = connectionReuses;
  for (let i = 0; i < 4; i++) {
    const r = await fetch(`http://127.0.0.1:${mockPort}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'connection': 'close',
        'x-bench-phase': 'pooling-calibration',
      },
      body: JSON.stringify({ model: 'gpt-5.6-sol', messages: [{ role: 'user', content: 'off' }] }),
      proxy: '',
    });
    await r.text();
  }
  const reuseDuringOff = connectionReuses - reuseBefore;

  // On: requests sent with Keep-Alive
  const reuseBeforeOn = connectionReuses;
  for (let i = 0; i < 8; i++) {
    const r = await fetch(`http://127.0.0.1:${mockPort}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'connection': 'keep-alive',
        'x-bench-phase': 'pooling-calibration',
      },
      body: JSON.stringify({ model: 'gpt-5.6-sol', messages: [{ role: 'user', content: 'on' }] }),
      proxy: '',
    });
    await r.text();
  }
  const reuseDuringOn = connectionReuses - reuseBeforeOn;

  // 5. Run bench locality
  const outFile = join(destination, 'locality-report.json');
  const benchEnv = {
    ...env,
    BENCH_MOCK_STATS_URL: `http://127.0.0.1:${mockPort}/_mock/stats`,
    BENCH_GATEWAY_PID: String(gwProc.pid),
    MAHOQUOT_BENCH_PHASE_ACK: '1',
  };
  // Import only after module initialization: resilience imports our ownership
  // helpers. This reuses its owned process sampler without a top-level cycle.
  const { getProcessStats } = await import('./bench-resilience.mjs');
  const phaseCollector = localityPhaseCollector({
    pid: gwProc.pid, evidence,
    measure: pid => getProcessStats(pid, {
      wait: (promise, label) => bounded(promise, label, 4000),
      listFds: async path => bounded((await import('node:fs/promises')).readdir(path), 'locality descriptor table', 4000),
    }),
    acknowledge: async (line, child) => {
      child.stdin.write(line);
      await bounded(child.stdin.flush(), 'locality phase acknowledgement', 4000);
    },
  });

    const sessionName = injectTenantCollision ? 'shared-cross-tenant-session' : 'bench-locality-session';
    const benchRun = owner.spawn([
      bench,
      'locality',
      '--url', `http://127.0.0.1:${env.BENCH_URL_PORT ?? gwPort}/v1/chat/completions`,
      '--out', outFile,
      '--turns', '5',
      '--session', sessionName,
    ], {
      cwd: root,
      env: benchEnv,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    }, phaseCollector.line);

    const [benchExit] = await bounded(Promise.all([benchRun.child.exited, benchRun.drained]), 'locality bench', 120000);
    evidence.event(null, 'locality-driver-exit', { code: benchExit });
    const report = await retainLocalityReport({
      readReport: () => readFile(outFile, 'utf8'), exitCode: benchExit,
      output: benchRun.output(), evidence, finishPhases: () => phaseCollector.finish(),
    });

    // Ensure b8_egress carries hop_log in the final report
    if (b8HopLog.length > 0 && (!report.b8_egress.hop_log || report.b8_egress.hop_log.length === 0)) {
      report.b8_egress.hop_log = b8HopLog;
    }

    // Attach measured pooling comparison
    report.b9_antigravity.measured_pooling_comparison = {
      pooling_off_reuses: reuseDuringOff,
      pooling_on_reuses: reuseDuringOn,
      reuse_delta: reuseDuringOn - reuseDuringOff,
    };

    report.raw_observations = evidence.raw;
    await writeFile(outFile, JSON.stringify(report, null, 2));
    return report;
  } catch (error) {
    evidence.raw.failure = String(error?.message ?? error);
    throw error;
  } finally {
    try { await owner.close(); }
    finally { if (rawPath) await writeFile(rawPath, JSON.stringify(evidence.raw, null, 2)); }
  }
}

if (import.meta.main) {
  runLocalityBenchmark()
    .then(r => console.log('Locality benchmark finished successfully:', r.matrix))
    .catch(err => {
      console.error(err);
      process.exitCode = 1;
    });
}
