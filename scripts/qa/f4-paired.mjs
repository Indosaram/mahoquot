#!/usr/bin/env bun
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostname } from 'node:os';
import http from 'node:http';
import { balancedOrder } from '../../mahoquot-proxy/tools/bench/scripts/fair-translation.mjs';
import { runLocalityBenchmark } from '../bench-locality.mjs';
import { runResilienceBenchmark } from '../bench-resilience.mjs';
import { validateResilienceReport } from './cases/bench-resilience.mjs';

const W = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const E = join(W, '.omo/evidence/cliproxy-remediation/6417c774-c554-4c53-880b-d8355082043e');
const binary = {
  baseline: '/Volumes/T9-Mac/tmp/f4-baseline-target/debug/mahoquot-gateway',
  candidate: join(E, 'target/debug/mahoquot-gateway'),
};
const BENCH = join(E, 'target/debug/bench');
// Candidate = the binary the current 76 task receipts are bound to.
const EXPECTED = 'd1b4dc168bc0be1fbdd5f1456299c07dae1b53b9c55e68d938f97ae70567116c';
const ROUNDS = 4, SEED = 35;
const LOCK = '/Volumes/T9-Mac/tmp/cliproxy-qa.lock.d';
const suites = { core: ['B0', 'B1', 'B2'], locality: ['B3', 'B4', 'B5', 'B8', 'B9'], resilience: ['B6', 'B7', 'B10', 'B11', 'B12', 'B13'] };
const hash = x => createHash('sha256').update(x).digest('hex');
const mean = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
const finite = xs => xs.filter(x => typeof x === 'number' && Number.isFinite(x));
const json = async (p, x) => writeFile(p, JSON.stringify(x, null, 2) + '\n');
const nativeSpawn = Bun.spawn.bind(Bun), nativeServe = Bun.serve.bind(Bun);
const nativeFetch = globalThis.fetch, nativeRequest = http.request;
const runtimeEnv = { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*', MAHOQUOT_QA_LOOPBACK_ONLY: '1' };

async function command(argv, options = {}) {
  const p = nativeSpawn(argv, { cwd: W, env: runtimeEnv, stdout: 'pipe', stderr: 'pipe', ...options });
  const timer = setTimeout(() => p.kill('SIGKILL'), 120000);
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  clearTimeout(timer);
  return { code, stdout, stderr };
}

function checkPorts() {
  const held = [];
  try {
    for (const port of [18840, 18841, 18842, 18843]) held.push(Bun.listen({ hostname: '127.0.0.1', port, socket: { data() {} } }));
  } finally { for (const p of held) p.stop(true); }
}

function classify(body, headers = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body ?? {});
  const marker = headers['x-bench-phase'];
  if (marker === 'b4' || text.includes('alternating route test')) return 'B4';
  if (marker === 'b5' || /parent root intent|child subagent execution|tenant2 collision/.test(text)) return 'B5';
  if (text.includes('query with history context and signatures')) return 'B3';
  if (/b8[- ]/.test(text)) return 'B8';
  if (/b9 antigravity/.test(text)) return 'B9';
  return 'setup';
}

function record(requests, phase, url) {
  const r = { phase, url: String(url), started_at: new Date().toISOString(), start: performance.now(), headers_ms: null, first_chunk_ms: null, end_ms: null, transport_error: null, status: null };
  requests.push(r);
  return r;
}

function instrument(requests, currentPhase) {
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.port !== '18841') return nativeFetch(input, init);
    const phase = currentPhase() ?? classify(init?.body);
    const r = record(requests, phase, url);
    try {
      const response = await nativeFetch(input, init);
      r.headers_ms = performance.now() - r.start; r.status = response.status;
      if (!response.body) { r.end_ms = r.headers_ms; return response; }
      const reader = response.body.getReader();
      const body = new ReadableStream({
        async pull(c) {
          try {
            const next = await reader.read();
            if (next.done) { r.end_ms = performance.now() - r.start; c.close(); }
            else { r.first_chunk_ms ??= performance.now() - r.start; c.enqueue(next.value); }
          } catch (error) { r.transport_error = String(error); r.end_ms = performance.now() - r.start; c.error(error); }
        },
        cancel(reason) { r.end_ms = performance.now() - r.start; r.cancelled = true; return reader.cancel(reason); },
      }, { highWaterMark: 0 });
      init?.signal?.addEventListener('abort', () => { r.cancelled = true; r.end_ms ??= performance.now() - r.start; }, { once: true });
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (error) { r.transport_error = String(error); r.end_ms = performance.now() - r.start; throw error; }
  };
  http.request = function (...args) {
    const options = args[0];
    if (String(options?.port) !== '18841') return nativeRequest.apply(this, args);
    const r = record(requests, currentPhase() ?? 'setup', options.path);
    const req = nativeRequest.apply(this, args);
    req.prependListener('response', res => {
      r.headers_ms = performance.now() - r.start; r.status = res.statusCode;
      res.on('data', () => { r.first_chunk_ms ??= performance.now() - r.start; });
      res.on('end', () => { r.end_ms = performance.now() - r.start; });
      res.on('error', e => { r.transport_error = String(e); r.end_ms = performance.now() - r.start; });
    });
    req.on('error', e => { r.transport_error = String(e); r.end_ms = performance.now() - r.start; });
    return req;
  };
}

async function timingProxy(requests, sample) {
  const sampled = new Set();
  const server = http.createServer(async (req, res) => {
    const started = performance.now();
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const r = record(requests, classify(body.toString(), req.headers), req.url); r.start = started;
    if (!sampled.has(r.phase)) { sampled.add(r.phase); sample(r.phase); }
    const upstream = nativeRequest({ hostname: '127.0.0.1', port: 18841, path: req.url, method: req.method, headers: req.headers }, response => {
      r.headers_ms = performance.now() - started; r.status = response.statusCode;
      res.writeHead(response.statusCode, response.headers);
      response.on('data', bytes => { r.first_chunk_ms ??= performance.now() - started; });
      response.on('end', () => { r.end_ms = performance.now() - started; });
      response.on('error', e => { r.transport_error = String(e); r.end_ms = performance.now() - started; res.destroy(e); });
      response.pipe(res);
    });
    upstream.on('error', e => { r.transport_error = String(e); r.end_ms = performance.now() - started; res.destroy(e); });
    res.on('close', () => { if (!res.writableEnded) { r.cancelled = true; r.end_ms ??= performance.now() - started; upstream.destroy(); } });
    upstream.end(body);
  });
  await new Promise((yes, no) => { server.once('error', no); server.listen(18843, '127.0.0.1', yes); });
  return server;
}

function coreFixture() {
  return Bun.serve({ hostname: '127.0.0.1', port: 18840, async fetch(req) {
    if (new URL(req.url).pathname.includes('/models')) return Response.json({ data: [{ id: 'gpt-5.6-sol', object: 'model', owned_by: 'openai' }] });
    await req.text();
    const codex = new URL(req.url).pathname.includes('responses');
    const events = codex ? [
      { type: 'response.created', response: { id: 'resp_f4', object: 'response', status: 'in_progress', model: 'gpt-5.6-sol' } },
      { type: 'response.output_item.added', output_index: 0, item: { id: 'msg_f4', type: 'message', role: 'assistant', status: 'in_progress', content: [] } },
      { type: 'response.content_part.added', content_index: 0, output_index: 0, item_id: 'msg_f4', part: { type: 'output_text', text: '' } },
      { type: 'response.output_text.delta', content_index: 0, output_index: 0, item_id: 'msg_f4', delta: 'xx' },
      { type: 'response.output_item.done', output_index: 0, item: { id: 'msg_f4', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'xx' }] } },
      { type: 'response.completed', response: { id: 'resp_f4', object: 'response', status: 'completed', usage: { input_tokens: 16, output_tokens: 2, total_tokens: 18 } } },
    ] : [
      { id: 'f4', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'xx' }, finish_reason: null }] },
      { id: 'f4', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 16, completion_tokens: 2, total_tokens: 18 } },
    ];
    return new Response(events.map(e => `${codex ? `event: ${e.type}\n` : ''}data: ${JSON.stringify(e)}\n\n`).join('') + (codex ? '' : 'data: [DONE]\n\n'), { headers: { 'content-type': 'text/event-stream' } });
  } });
}

async function core(side, dir, phaseHook) {
  coreFixture();
  const auth = join(dir, 'auth'); await mkdir(auth);
  await json(join(auth, 'codex-f4.json'), { identity_slug: 'f4', email: 'f4@example.invalid', id_token: 'dummy', last_refresh: '2026-01-01T00:00:00Z', access_token: 'dummy', account_id: 'f4', refresh_token: 'dummy', type: 'plus', expired: '2099-01-01T00:00:00Z', upstream_override: 'http://127.0.0.1:18840' });
  await writeFile(join(auth, 'config.yaml'), 'routing:\n  strategy: fill-first\nrequest-retry: 0\nmax-retry-credentials: 1\nusage-statistics-enabled: false\nmodel-catalog:\n  refresh-enabled: false\napi-keys:\n  - benchkey\n');
  const gateway = Bun.spawn([binary[side], 'serve', '--bind', '127.0.0.1', '--port', '18841', '--auth-dir', auth, '--config', join(auth, 'config.yaml'), '--auth-refresh', 'false'], { env: runtimeEnv, stdout: 'pipe', stderr: 'pipe' });
  const ready = new Promise((yes, no) => {
    const timer = setTimeout(() => no(new Error('core gateway readiness deadline')), 15000);
    const drain = async stream => { for await (const bytes of stream) if (/listening|server started|strategy=FillFirst/i.test(Buffer.from(bytes).toString())) { clearTimeout(timer); yes(); } };
    drain(gateway.stdout).catch(no); drain(gateway.stderr).catch(no);
    gateway.exited.then(code => { clearTimeout(timer); no(new Error(`core gateway exit ${code}`)); });
  });
  await ready;
  const reports = {};
  for (const [i, path] of ['/v1/chat/completions', '/v1/messages', '/v1/responses'].entries()) {
    const id = `B${i}`; phaseHook(id);
    const body = { model: 'gpt-5.6-sol', stream: true, bench_expect: { text: 'xx', input_tokens: 16, output_tokens: 2 }, ...(i === 2 ? { input: 'F4 responses fixture' } : { messages: [{ role: 'user', content: `F4 ${id} fixture` }], ...(i === 1 ? { max_tokens: 32 } : { stream_options: { include_usage: true } }) }) };
    const out = join(dir, `${id}-bench.json`);
    const argv = [BENCH, 'run', '--url', `http://127.0.0.1:18841${path}`, '--total', '10', '--concurrency', '2', '--out', out, '--body-json', JSON.stringify(body), '--header', 'authorization: Bearer benchkey', ...(i === 1 ? ['--header', 'anthropic-version: 2023-06-01'] : [])];
    const client = Bun.spawn(argv, { env: runtimeEnv, stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, code] = await Promise.all([new Response(client.stdout).text(), new Response(client.stderr).text(), client.exited]);
    reports[id] = { ...JSON.parse(await readFile(out, 'utf8')), client: { argv, stdout, stderr, code } };
      phaseHook(id);
  }
  return reports;
}

async function worker(suite, side, dir) {
  checkPorts(); await mkdir(dir, { recursive: true });
  let phase = suite === 'resilience' ? 'setup' : null, gatewayPid;
  const requests = [], children = [], servers = [], pendingStats = [], stats = {}, logs = [];
  const sample = id => {
    if (!gatewayPid) return;
    const pid = gatewayPid;
    pendingStats.push((async () => {
      const [rss, fd] = await Promise.all([command(['ps', '-o', 'rss=', '-p', String(pid)]), command(['lsof', '-nP', '-p', String(pid)])]);
      if (rss.code === 0 && fd.code === 0) {
        const value = { pid, phase: id, rss_bytes: Number(rss.stdout.trim()) * 1024, fd_count: fd.stdout.split('\n').filter(line => /^\S+\s+\d+\s+\S+\s+\d+[rwu-]?\s/.test(line)).length };
        (stats[id] ??= []).push(value);
      }
    })());
  };
  const phaseHook = name => { if (phase) sample(phase); phase = name; sample(name); };
  Bun.spawn = function (argv, options) {
    const p = nativeSpawn(argv, options); children.push(p);
    if (argv[0] === binary[side]) {
      gatewayPid = p.pid; sample('startup');
      // Tee, rather than steal, pipes consumed by the existing scenario helper.
      for (const key of ['stdout', 'stderr']) if (p[key]?.tee) {
        const [consumer, capture] = p[key].tee();
        Object.defineProperty(p, key, { value: consumer });
        pendingStats.push(new Response(capture).text().then(text => { logs.push({ pid: p.pid, channel: key, text }); }));
      }
    }
    return p;
  };
  Bun.serve = function (options) { const s = nativeServe(options); servers.push(s); return s; };
  instrument(requests, () => phase);
  let proxy, report = null, failure = null;
  const cleanup = async () => {
    for (const p of children) if (p.exitCode === null) p.kill('SIGKILL');
    await Promise.all(children.map(p => p.exited));
    for (const s of servers) s.stop(true);
    if (proxy) { proxy.closeAllConnections(); await new Promise(yes => proxy.close(yes)); }
  };
  const watchdog = setTimeout(async () => { await cleanup(); process.exit(124); }, 180000);
  process.once('SIGTERM', async () => { await cleanup(); process.exit(143); });
  try {
    // The pristine baseline predates the dedicated management secret (Task 26)
    // and gates management with the inference master key.
    const env = { ...runtimeEnv, GWBIN: binary[side], BENCH, MOCK_PORT: '18840', GW_PORT: '18841', PROXY_PORT: '18842', BENCH_URL_PORT: '18843', BENCH_EVIDENCE: dir, F4_PHASE_HOOK: phaseHook, ...(side === 'baseline' ? { BENCH_MGMT_AUTH: 'master' } : {}) };
    if (suite === 'core') report = await core(side, dir, phaseHook);
    else if (suite === 'locality') { proxy = await timingProxy(requests, sample); report = await runLocalityBenchmark(env); }
    else report = await runResilienceBenchmark(env);
  } catch (e) { failure = String(e); }
  finally {
    await cleanup(); await Promise.all(pendingStats);
    globalThis.fetch = nativeFetch; http.request = nativeRequest; Bun.spawn = nativeSpawn; Bun.serve = nativeServe;
    clearTimeout(watchdog);
  }
  const configFiles = [];
  try { for (const name of (await readdir(join(dir, 'auth'))).sort()) if (/\.json$|\.yaml$/.test(name)) configFiles.push({ name, sha256: hash(await readFile(join(dir, 'auth', name))) }); } catch {}
  await json(join(dir, 'raw.json'), { suite, side, report, failure, requests, stats, logs, config_files: configFiles });
  console.log(`F4_WORKER ${suite} ${side} requests=${requests.length} failure=${failure ?? 'none'}`);
}

function localityVerdicts(r) {
  if (!r) return {};
  const a = r.b3_history, b = r.b4_alternating, c = r.b5_hierarchy, d = r.b8_egress, e = r.b9_antigravity;
  return {
    B3: a?.rounds === 5 && a.signature_recall_success && a.raw_routing_headers_leaked === 0 && a.hops === 5 && a.rebind_count === 0 && a.prompt_tokens_growth?.length === 5 && a.p50_ms > 0,
    B4: b?.alternations === 4 && b.independent_binding_retained && b.failover_recovery_ok && typeof b.account_hops === 'number' && typeof b.cache_affinity_opportunity_loss === 'number',
    B5: c?.branches_tested === 3 && c.cross_tenant_collisions === 0 && c.parent_policy_honored,
    B8: d?.total_requests === 10 && d.next_request_correct_egress && d.inflight_intact && d.direct_fallback_count === 0 && d.hop_log?.length > 0 && d.hop_log.every(h => typeof h.request_id === 'string' && h.request_id && typeof h.timestamp === 'string' && h.timestamp && typeof h.passed_loopback_proxy === 'boolean' && typeof h.reached_mock_directly === 'boolean' && h.passed_loopback_proxy !== h.reached_mock_directly && h.config_generation > 0),
    B9: e?.pooling_enabled && e.accounts_tested === 2 && e.connection_reuse_count > 0 && e.cross_account_leaks === 0 && e.peak_rss_bytes > 0 && e.peak_fds > 0,
  };
}

function summarize(raw, id) {
  const requests = raw.requests.filter(r => r.phase === id);
  const stats = raw.stats[id] ?? raw.stats.startup ?? [];
  let passed = false, coreReport;
  if (raw.suite === 'core') { coreReport = raw.report?.[id]; passed = coreReport?.correctness_passed && coreReport.failed === 0; }
  else if (raw.suite === 'locality') passed = Boolean(localityVerdicts(raw.report)[id]);
  else if (raw.report) passed = validateResilienceReport(raw.report)[`${id.toLowerCase()}Passed`];
  const resourceKey = { B10: 'b10_slow_client', B11: 'b11_concurrency_ceiling', B13: 'b13_sqlite_telemetry', B9: 'b9_antigravity' }[id];
  const resources = raw.report?.[resourceKey];
  const unavailable = !coreReport && requests.length === 0;
  return {
    samples: 1, passed: Boolean(passed), unavailable, request_count: coreReport?.total ?? requests.length,
    ttfb_ms: coreReport ? mean(coreReport.ttfb_ms ?? []) : mean(finite(requests.map(r => r.headers_ms))),
    content_ttft_ms: coreReport ? coreReport.ttft_ms?.p50 ?? 0 : mean(finite(requests.map(r => r.first_chunk_ms))),
    completion_ms: coreReport ? mean(coreReport.completion_ms ?? []) : mean(finite(requests.map(r => r.end_ms))),
    errors: coreReport ? coreReport.failed : (passed ? 0 : 1) + requests.filter(r => r.transport_error).length,
    rss_bytes: Math.max(0, ...stats.map(s => s.rss_bytes), ...finite([resources?.peak_rss_bytes, resources?.outstanding_rss_bytes])),
    fd_count: Math.max(0, ...stats.map(s => s.fd_count), ...finite([resources?.peak_fds, resources?.outstanding_fds])),
    observed_counts: { headers: finite(requests.map(r => r.headers_ms)).length, first_chunk: finite(requests.map(r => r.first_chunk_ms)).length, end: finite(requests.map(r => r.end_ms)).length },
    failure: raw.failure,
  };
}

async function acquireLock() {
  try { await mkdir(LOCK); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const pid = Number((await readFile(join(LOCK, 'pid'), 'utf8')).trim());
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('QA lock pid invalid');
    try { process.kill(pid, 0); } catch (e) {
      if (e.code !== 'ESRCH') throw e;
      await rm(LOCK, { recursive: true }); await mkdir(LOCK); await writeFile(join(LOCK, 'pid'), String(process.pid)); return;
    }
    throw new Error(`QA lock held by live pid ${pid}`);
  }
  await writeFile(join(LOCK, 'pid'), String(process.pid));
}

async function main() {
  const candidateHash = hash(await readFile(binary.candidate));
  if (candidateHash !== EXPECTED) throw new Error('candidate hash mismatch');
  const baselineHash = hash(await readFile(binary.baseline));
  const revision = (await command(['git', '-C', join(W, 'mahoquot-proxy'), 'rev-parse', 'HEAD'])).stdout.trim();
  const provenance = { baseline_sha256: baselineHash, candidate_sha256: candidateHash, baseline_revision: 'e45abe155cf435f68e6521917828693d66381c5e', candidate_revision: revision, host: hostname(), platform: process.platform, architecture: process.arch, rustc: (await command(['rustc', '-V'])).stdout.trim(), seed: SEED, rounds: ROUNDS, bench_sha256: hash(await readFile(BENCH)) };
  const runRoot = join(E, 'f4-runs', randomUUID());
  await mkdir(runRoot, { recursive: true });
  provenance.run_root = relative(E, runRoot);
  const all = {};
  await acquireLock();
  try {
    for (let round = 0; round <= ROUNDS; round++) for (const tier of balancedOrder(round, SEED)) {
      const side = tier === 'B' ? 'baseline' : 'candidate';
      for (const suite of Object.keys(suites)) {
        checkPorts();
        const dir = join(runRoot, `${round === 0 ? 'warmup' : `round-${round}`}-${side}-${suite}`);
        const result = await command([process.execPath, fileURLToPath(import.meta.url), '--worker', suite, side, dir]);
        await json(join(runRoot, `${round}-${side}-${suite}-process.json`), result);
        if (result.code !== 0) throw new Error(`worker ${suite}/${side}/${round} exited ${result.code}: ${result.stderr}`);
        const raw = JSON.parse(await readFile(join(dir, 'raw.json'), 'utf8'));
        for (const id of suites[suite]) {
          const entry = { round, side, id, discarded: round === 0, raw: relative(E, join(dir, 'raw.json')), ...summarize(raw, id) };
          await json(join(dir, `${id}.json`), entry);
          if (round) ((all[id] ??= {})[side] ??= []).push(entry);
        }
        console.log(`F4_ROUND ${round} ${side} ${suite} ${raw.failure ?? 'complete'}`);
        checkPorts();
      }
    }
    const benchmarks = {};
    for (let i = 0; i < 14; i++) {
      const id = `B${i}`, pair = { seed: SEED, config_sha256: hash(JSON.stringify({ id, seed: SEED, rounds: ROUNDS, ports: [18840, 18841, 18842, 18843], scripts: [hash(await readFile(fileURLToPath(import.meta.url))), hash(await readFile(join(W, 'scripts/bench-locality.mjs'))), hash(await readFile(join(W, 'scripts/bench-resilience.mjs')))] })) };
      for (const side of ['baseline', 'candidate']) {
        const rows = all[id][side]; if (rows.length !== ROUNDS) throw new Error(`missing rounds ${id}/${side}`);
        pair[side] = { samples: ROUNDS, errors: rows.reduce((n, x) => n + x.errors, 0), request_count: rows.reduce((n, x) => n + x.request_count, 0), unavailable_rounds: rows.filter(r => r.unavailable).length };
        for (const field of ['ttfb_ms', 'content_ttft_ms', 'completion_ms']) pair[side][field] = mean(rows.map(r => r[field]));
        for (const field of ['rss_bytes', 'fd_count']) pair[side][field] = Math.max(...rows.map(r => r[field]));
      }
      benchmarks[id] = pair;
    }
    const table = ['| B | Samples B/C | Requests B/C | TTFB ms B/C | First chunk / TTFT ms B/C | Completion ms B/C | Errors B/C | RSS bytes B/C | FDs B/C |', '|---|---:|---:|---:|---:|---:|---:|---:|---:|'];
    for (const [id, p] of Object.entries(benchmarks)) table.push(`| ${id} | ${['samples', 'request_count', 'ttfb_ms', 'content_ttft_ms', 'completion_ms', 'errors', 'rss_bytes', 'fd_count'].map(k => `${p.baseline[k].toFixed(3)} / ${p.candidate[k].toFixed(3)}`).join(' | ')} |`);
    const caveats = [...new Set(Object.values(all).flatMap(p => Object.entries(p).flatMap(([side, rows]) => rows.filter(r => r.failure || r.unavailable).map(r => `${r.id} ${side}: ${r.failure ?? 'no gateway request observed'}`))))];
    const md = `# F4 paired scenario measurements\n\n## Provenance\n\n\`\`\`json\n${JSON.stringify(provenance, null, 2)}\n\`\`\`\n\n## Method\n\nFour paired scenario trials, seed 35; order from balancedOrder(round, seed). One full discarded suite warm-up per side precedes all measured trials. Samples count scenario trials (4 each); request_count records actual gateway requests separately. B0-B2 each run bench --total 10 --concurrency 2 with semantic bench_expect. Their timings come from the bench report: mean TTFB, p50 content TTFT, mean completion. Other timings are the mean per-trial gateway headers/first-body-chunk/end observations; first chunk is not claimed to parse semantic content. Fetch and node:http instrumentation captures resilience traffic; a byte-preserving timing reverse proxy tags locality client traffic by body/session markers. Locality setup gateway traffic is captured separately through fetch. All suite calls use the original scenarios, loopback ports, dummy credentials, and upstream_override.\n\nRSS/FD values are scenario snapshots or the scenario's own peak fields, not continuously sampled process peaks. Errors for resilience are failed-verdict trials plus transport errors, including intentional aborts when surfaced as transport errors. Locality errors are failed per-B verdict trials plus transport errors.\n\n${table.join('\n')}\n\n## Caveats\n\nUnsupported setup is a failed trial, never success. If a suite cannot reach later phases, those phases are marked unavailable and retain zero observations; zero timing/resource fields with no observations are schema sentinels, not measured zero performance. They cannot support performance comparisons. No failed correctness requests are dropped. A suite abort prevents its later phases from running; the raw file records the exact failure and gateway logs.\n\n${caveats.map(c => '- ' + c).join('\n')}\n\nRaw run: ${provenance.run_root}. Older f4-runs files are rejected development output and are not referenced by this run.\n`;
    await writeFile(join(E, 'F4.md'), md);
    const tasks = { 'IS-1': [2, 3, 7], 'IS-2': [4, 5, 6, 9, 11], 'IS-3': [8, 10, 13, 14], 'IS-4': [12, ...Array.from({ length: 11 }, (_, i) => i + 15)], 'IS-5': Array.from({ length: 9 }, (_, i) => i + 26), 'IS-6': [35, 36, 37], 'IS-7': [26, 37, 38] };
    const is_rows = {};
    for (const [id, numbers] of Object.entries(tasks)) {
      const evidence = [];
      for (const path of [...numbers.flatMap(n => [`task-${n}-happy.json`, `task-${n}-failure.json`]), 'F4.md']) {
        const bytes = await readFile(join(E, path));
        if (path !== 'F4.md' && !JSON.parse(bytes).assertions.every(a => a.pass === true)) throw new Error(`failed receipt ${path}`);
        evidence.push({ path, sha256: hash(bytes), pass: true });
      }
      is_rows[id] = { pass: true, evidence };
    }
    await json(join(E, 'F4-fidelity.json'), { schema: 'cliproxy-audit/f4-fidelity-v1', provenance, is_rows, benchmarks });
    console.log(`F4_COMPLETE ${runRoot}`);
  } finally { await rm(LOCK, { recursive: true }); }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  (args[0] === '--worker' ? worker(args[1], args[2], args[3]) : main()).catch(e => { console.error(e); process.exitCode = 1; });
}
