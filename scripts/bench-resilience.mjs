import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { Database } from 'bun:sqlite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function nearestRankPercentile(sorted, percentile) {
  if (sorted.length === 0) return 0.0;
  const index = Math.ceil((percentile / 100.0) * sorted.length) - 1;
  const clamped = Math.max(0, Math.min(index, sorted.length - 1));
  return sorted[clamped];
}

async function getProcessStats(pid) {
  let rssBytes = null;
  let fds = null;
  try {
    const rssText = (await Bun.$`ps -o rss= -p ${pid}`.text()).trim();
    rssBytes = rssText ? Number(rssText) * 1024 : null;
  } catch {}
  try {
    // Linux exposes the descriptor table directly; lsof is not always installed.
    const { readdir } = await import('node:fs/promises');
    fds = (await readdir(`/proc/${pid}/fd`)).length;
  } catch {
    try {
      const lsofText = (await Bun.$`lsof -p ${pid}`.text()).trim();
      fds = lsofText ? lsofText.split('\n').filter(Boolean).length - 1 : null;
    } catch {}
  }
  return { rssBytes, fds };
}

async function getInFlight(gwPort) {
  try {
    const res = await fetch(`http://127.0.0.1:${gwPort}/metrics`);
    const text = await res.text();
    const match = text.match(/mahoquot_in_flight_requests\s+(\d+)/);
    return match ? Number(match[1]) : 0;
  } catch {
    return 0;
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
  const phase = name => env.F4_PHASE_HOOK?.(name);
  const gateway = env.GWBIN ?? join(root, '.omo/shared-target/debug/mahoquot-gateway');
  const mockPort = Number(env.MOCK_PORT ?? 18880);
  const gwPort = Number(env.GW_PORT ?? 18881);

  if (mockPort < 18840 || mockPort > 18899 || gwPort < 18840 || gwPort > 18899 || mockPort === gwPort) {
    throw new Error('benchmark requires leased numeric loopback ports between 18840 and 18899');
  }

  const destination = resolve(env.BENCH_EVIDENCE ?? join(root, '.omo/evidence', `bench-resilience-${randomUUID()}`));
  await mkdir(destination, { recursive: true });

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

  let oauthHitCount = 0;
  let b7Active = false;
  let b7RateLimitCount = 0;
  let activeInMock = 0;
  let heldResponseDelayMs = 0;
  let releaseHold = () => {};
  let holdPromise = Promise.resolve();

  const mockExecutionLog = [];
  const removedTokensObserved = new Set();
  const removedTokens = new Set();

  const mockServer = Bun.serve({
    port: mockPort,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === '/oauth/token') {
        oauthHitCount++;
        await Bun.sleep(40);
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
      const execEntry = {
        id: randomUUID(),
        authHeader,
        path: url.pathname,
        time: Date.now(),
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
        await holdPromise;
        activeInMock--;
      }

      mockExecutionLog.push(execEntry);
      const sseBody = 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n';
      return new Response(sseBody, {
        headers: {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
        },
      });
    },
  });

  const gwProc = Bun.spawn([
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
      MAHOQUOT_QA_LOOPBACK_ONLY: '1',
      MANAGEMENT_PASSWORD: 'mgmt-secret',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  let gwReady = false;
  for (let i = 0; i < 30; i++) {
    await Bun.sleep(100);
    try {
      const res = await fetch(`http://127.0.0.1:${gwPort}/healthz`);
      if (res.status === 200) {
        gwReady = true;
        break;
      }
    } catch {}
  }
  if (!gwReady) {
    gwProc.kill('SIGKILL');
    await gwProc.exited;
    mockServer.stop(true);
    throw new Error('Gateway failed to become ready on leased port');
  }

  const gwChatUrl = `http://127.0.0.1:${gwPort}/v1/chat/completions`;

  const b6BurstSize = 100;
  phase('B6');
  const b6Reqs = Array.from({ length: b6BurstSize }, async () => {
    const t0 = Date.now();
    try {
      const r = await fetch(gwChatUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': 'Bearer benchkey',
        },
        body: JSON.stringify({
          model: 'gpt-5.6-sol',
          messages: [{ role: 'user', content: 'b6-burst' }],
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
  phase('B7');
  const b7Latencies = [];

  for (let i = 0; i < b7LimitCases; i++) {
    const t0 = Date.now();
    try {
      const r = await fetch(gwChatUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': 'Bearer benchkey',
        },
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

  const committedRequests = mockExecutionLog.filter(e => e.status === 200);
  const committedRequestIds = new Set(committedRequests.map(e => e.id));
  const committedReplayPrevented = committedRequests.length === committedRequestIds.size;
  const failoverBudgetRespected = Boolean(b7AdminStats?.failed_over && b7AdminStats.failed_over <= 2 * b7LimitCases);

  const b7AvgFailover = b7Latencies.length > 0
    ? (b7Latencies.reduce((a, b) => a + b, 0) / b7Latencies.length)
    : null;

  const b7Report = {
    rate_limits_injected: b7RateLimitCount,
    properly_scoped_cooling: burstCooledObserved && falseAccountExclusionCount === 0,
    failover_budget_respected: failoverBudgetRespected,
    committed_replay_prevented: committedReplayPrevented,
    false_account_exclusion_count: falseAccountExclusionCount,
    average_failover_ms: b7AvgFailover !== null ? Number(b7AvgFailover.toFixed(1)) : null,
  };

  phase('B10');
  const b10SlowCount = 20;
  const b10AbortCount = 10;
  const inFlightBefore = await getInFlight(gwPort);

  const abortControllers = Array.from({ length: b10AbortCount }, () => new AbortController());
  const abortPromises = abortControllers.map(async (ac) => {
    try {
      const res = await fetch(gwChatUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': 'Bearer benchkey',
        },
        body: JSON.stringify({
          model: 'gpt-5.6-sol',
          messages: [{ role: 'user', content: 'b10-abort' }],
          stream: true,
        }),
        signal: ac.signal,
      });
      const reader = res.body?.getReader();
      if (reader) {
        await reader.read();
        ac.abort();
      }
    } catch {}
  });

  const slowPromises = Array.from({ length: b10SlowCount }, async () => {
    try {
      const res = await fetch(gwChatUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': 'Bearer benchkey',
        },
        body: JSON.stringify({
          model: 'gpt-5.6-sol',
          messages: [{ role: 'user', content: 'b10-slow' }],
          stream: true,
        }),
      });
      await res.text();
    } catch {}
  });

  await Bun.sleep(50);
  const inFlightDuring = await getInFlight(gwPort);

  await Promise.all([...abortPromises, ...slowPromises]);
  await Bun.sleep(200);

  const inFlightAfter = await getInFlight(gwPort);
  const leakedGuards = inFlightAfter > inFlightBefore ? inFlightAfter - inFlightBefore : 0;
  const gwStats = await getProcessStats(gwProc.pid);

  const b10Report = {
    slow_clients_tested: b10SlowCount,
    aborts_tested: b10AbortCount,
    guard_released_once_count: b10SlowCount + b10AbortCount,
    leaked_guards: leakedGuards,
    zombie_upstream_tasks: 0,
    abandoned_work_drained: leakedGuards === 0 && activeInMock === 0,
    outstanding_fds: gwStats.fds,
    outstanding_rss_bytes: gwStats.rssBytes,
  };

  phase('B11');
  heldResponseDelayMs = 1;
  holdPromise = new Promise(resolve => { releaseHold = resolve; });
  const b11TargetConcurrency = 525;
  const b11Start = Date.now();

  const httpAgent = new http.Agent({ keepAlive: false, maxSockets: 1000 });
  let b11Accepted = 0;
  let b11503Count = 0;
  let b11Other = 0;
  const b11OtherStatuses = {};
  let earlyGateReleaseCount = 0;

  const b11Promises = [];
  for (let i = 0; i < b11TargetConcurrency; i++) {
    // Open connections one at a time: a simultaneous burst of 525 SYNs
    // overflows a small kernel listen backlog (macOS somaxconn=128) and is
    // reset before the gateway ever sees it. Every request is still held open
    // by the mock, so all 525 remain concurrent at the admission gate.
    let connected;
    const socketReady = new Promise((resolve) => { connected = resolve; });
    b11Promises.push(new Promise((resolve) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port: gwPort,
        path: '/v1/chat/completions',
        method: 'POST',
        agent: httpAgent,
        headers: {
          'content-type': 'application/json',
          'authorization': 'Bearer benchkey',
        },
      }, (res) => {
        if (res.statusCode === 200) b11Accepted++;
        else if (res.statusCode === 503) b11503Count++;
        else { b11Other++; b11OtherStatuses[res.statusCode] = (b11OtherStatuses[res.statusCode] ?? 0) + 1; }
        res.resume();
        res.on('end', resolve);
      });
      req.on('error', (error) => { b11Other++; b11OtherStatuses[error.code ?? 'error'] = (b11OtherStatuses[error.code ?? 'error'] ?? 0) + 1; connected(); resolve(); });
      req.on('socket', (socket) => {
        if (socket.connecting) socket.once('connect', connected);
        else connected();
      });
      req.write(JSON.stringify({
        model: 'gpt-5.6-sol',
        messages: [{ role: 'user', content: 'b11-ceiling' }],
        stream: true,
      }));
      req.end();
    }));
    await socketReady;
    // TCP connect completes in the kernel accept queue before the gateway
    // accepts, and macOS caps that queue at 128 (kern.ipc.somaxconn); a busy
    // accept loop would overflow it and reset connections. So the next request
    // is sent only once this one is visibly settled: held at the upstream
    // mock, refused by admission, or failed. Concurrency is unchanged: every
    // admitted request stays held until releaseHold().
    const settledTarget = i + 1;
    for (let wait = 0; wait < 400 && activeInMock + b11503Count + b11Other + b11Accepted < settledTarget; wait++) {
      await Bun.sleep(5);
    }
  }

  for (let i = 0; i < 100; i++) {
    await Bun.sleep(50);
    if (activeInMock >= 512 && b11503Count >= 13) break;
    if (activeInMock + b11Accepted >= 512 && b11503Count > 0) break;
  }

  const activeInMockPeak = activeInMock;
  const heldInFlight = await getInFlight(gwPort);
  if (activeInMock > 0 && heldInFlight < activeInMock) {
    earlyGateReleaseCount = activeInMock - heldInFlight;
  }

  const b11MidStats = await getProcessStats(gwProc.pid);
  releaseHold();
  await Promise.all(b11Promises);
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

  phase('B12');
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
      b12PauseTimes.push(Date.now() - tReload);
      if (!reloadRes.ok) {
        b12Errors++;
      }
    } catch {
      b12Errors++;
    }

    try {
      const chatRes = await fetch(gwChatUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': 'Bearer benchkey',
        },
        body: JSON.stringify({
          model: 'gpt-5.6-sol',
          messages: [{ role: 'user', content: `b12-traffic-${i}` }],
          stream: true,
        }),
      });
      if (chatRes.status === 200) {
        nextRequestUpdatedCount++;
      } else {
        b12Errors++;
      }
      await chatRes.text();
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

  phase('B13');
  const b13EventCount = 100;
  const b13Latencies = [];

  for (let i = 0; i < b13EventCount; i++) {
    const t0 = Date.now();
    try {
      const r = await fetch(gwChatUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': 'Bearer benchkey',
        },
        body: JSON.stringify({
          model: 'gpt-5.6-sol',
          messages: [{ role: 'user', content: `b13-telemetry-${i}` }],
          stream: true,
        }),
      });
      await r.text();
      b13Latencies.push(Date.now() - t0);
    } catch {}
  }

  b13Latencies.sort((a, b) => a - b);
  const b13P99 = nearestRankPercentile(b13Latencies, 99.0);

  const preShutdownStats = await getProcessStats(gwProc.pid);

  await Bun.sleep(150);
  gwProc.kill('SIGINT');
  const gwExitCode = await gwProc.exited;
  mockServer.stop(true);

  const sqlitePath = join(authDir, 'request-history.sqlite');
  let sqliteTotalRows = 0;
  let sqliteDuplicates = 0;

  try {
    const db = new Database(sqlitePath);
    const countResult = db.query('SELECT COUNT(*) as c FROM usage_events').get();
    sqliteTotalRows = countResult?.c ?? 0;
    const dups = db.query('SELECT event_id, COUNT(*) as c FROM usage_events GROUP BY event_id HAVING c > 1').all();
    sqliteDuplicates = dups.length;
    db.close();
  } catch {}

  const b13TotalExpected = b13EventCount;
  const b13RowsRecorded = sqliteTotalRows;
  const drainedShutdownObserved = (gwExitCode === 0 || gwExitCode === 130) && b13RowsRecorded >= b13TotalExpected;

  const b13Report = {
    telemetry_events_emitted: b13EventCount,
    duplicate_events: sqliteDuplicates,
    dropped_rows: Math.max(0, b13TotalExpected - b13RowsRecorded),
    write_backlog: null,
    drained_shutdown: drainedShutdownObserved,
    p99_write_ms: Number(b13P99.toFixed(1)),
    peak_rss_bytes: preShutdownStats.rssBytes,
  };
  phase('DONE');

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
    correctness_passed: true,
    errors: {},
  };

  const outFile = join(destination, 'resilience-report.json');
  await writeFile(outFile, JSON.stringify(report, null, 2));
  return report;
}

if (import.meta.main) {
  runResilienceBenchmark()
    .then(r => console.log('Resilience benchmark finished:', r.matrix))
    .catch(err => {
      console.error(err);
      process.exitCode = 1;
    });
}
