#!/usr/bin/env node
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const evidence = path.resolve('.omo/evidence/warmup-config/process-http');
const binary = path.resolve(process.env.GATEWAY_BIN ?? 'mahoquot-proxy/target/debug/mahoquot-gateway');
const base = 'http://127.0.0.1:18841';
const upstream = 'http://127.0.0.1:18842';
const master = 'warmup-mock-master';
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'warmup-process-'));
const auth = path.join(temp, 'auth');
const config = path.join(temp, 'config.yaml');
await fs.mkdir(auth);
await fs.mkdir(evidence, { recursive: true });
let gateway;
let mode = 'valid';
let sequence = 0;
const captures = [];
const results = [];
let fixtureError;
const mock = http.createServer((req, res) => {
  handleMock(req, res).catch(error => {
    fixtureError = error;
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: error.message }));
  });
});
async function handleMock(req, res) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const rawBody = Buffer.concat(chunks).toString();
  captures.push({ url: req.url, method: req.method, headers: req.headers, rawBody, mode });
  if (!req.url.includes('chat/completions')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
    return;
  }
  assert.equal(JSON.parse(rawBody).model, 'z-ai/glm-5.3-flash');
  if (mode === 'cooldown') {
    res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '9000' });
    res.end(JSON.stringify({ error: { code: 'INFERENCE_CAP_ERROR', message: 'Daily free limit reached on model z-ai/glm-5.3-flash. Try again in 2h 30m' } }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  if (mode === 'empty') return res.end();
  if (mode === 'done') return res.end('data: [DONE]\n\n');
  res.write('data: {"choices":[{"delta":{"content":"x"},"finish_reason":null}]}\n\n');
  if (mode === 'error') res.write('data: {"error":{"message":"after content"}}\n\n');
  res.end('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
}
function count() { return captures.filter(r => r.url.includes('chat/completions')).length; }
async function curl(name, method, route, body, key = master, expected = 200) {
  const args = ['-sS', '-i', '--max-time', '10', '-X', method, '-H', `Authorization: Bearer ${key}`];
  if (body !== undefined) args.push('-H', 'Content-Type: application/json', '--data', JSON.stringify(body));
  args.push(`${base}${route}`);
  const child = spawn('curl', args);
  const output = [];
  const errors = [];
  child.stdout.on('data', b => output.push(b));
  child.stderr.on('data', b => errors.push(b));
  const [code] = await once(child, 'close');
  if (fixtureError) throw fixtureError;
  assert.equal(code, 0, Buffer.concat(errors).toString());
  const text = Buffer.concat(output).toString();
  await fs.writeFile(path.join(evidence, `${String(++sequence).padStart(2, '0')}-${name}.txt`), `curl ${args.map(a => JSON.stringify(a)).join(' ')}\n${text}`);
  const status = Number(text.match(/^HTTP\/\S+ (\d+)/)[1]);
  assert.equal(status, expected, text);
  const raw = text.slice(text.indexOf('\r\n\r\n') + 4);
  const parsed = raw.startsWith('{') ? JSON.parse(raw) : raw;
  results.push({ name, status, body: parsed, upstreamGenerations: count() });
  return parsed;
}
async function start() {
  const args = ['--port', '18841', '--bind', '127.0.0.1', '--auth-dir', auth, '--config', config, '--api-keys', master, '--auth-refresh', 'false', '--refresh-url', `${upstream}/refresh`, '--usage-poll-secs', '86400'];
  gateway = spawn(binary, args, { env: { PATH: process.env.PATH, HOME: temp, MAHOQUOT_CACHE_DIR: temp, RUST_LOG: 'info' } });
  const child = gateway;
  await new Promise((resolve, reject) => {
    let log = '';
    const timeout = setTimeout(() => reject(new Error('gateway listening event timeout')), 10000);
    const data = chunk => {
      log += chunk.toString();
      if (/listening/.test(log)) { clearTimeout(timeout); resolve(); }
    };
    child.stdout.on('data', data);
    child.stderr.on('data', data);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`gateway exited ${code}: ${log}`)); });
    child.once('close', () => fs.appendFile(path.join(evidence, 'gateway.log'), log));
  });
}
async function stop() {
  if (!gateway) return;
  const child = gateway;
  gateway = undefined;
  if (child.exitCode !== null) return;
  const closed = once(child, 'close');
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  try { await closed; } finally { clearTimeout(timer); }
}
try {
  const listening = once(mock, 'listening');
  mock.listen(18842, '127.0.0.1');
  await listening;
  for (const [id, provider, disabled] of [['cline', 'cline', false], ['disabled', 'cline', true], ['unsupported', 'other-fixture', false]]) {
    await fs.writeFile(path.join(auth, `generic-${id}.json`), JSON.stringify({ type: 'generic', identity_slug: id, provider, adapter: 'openai', base_url: upstream, upstream_override: upstream, usage_override: upstream, api_key: 'mock-only', models: ['z-ai/glm-5.3-flash'], disabled }));
  }
  await start();
  const settingsPath = '/v0/management/warmup/settings';
  const provider = { enabled: false, model: null, idle_secs: 3600, min_interval_secs: 300 };
  assert.deepEqual(await curl('provider-off', 'PUT', `${settingsPath}/provider/cline`, provider), provider);
  for (const policy of [{ type: 'inherit' }, { type: 'custom', model: 'z-ai/glm-5.3-flash', idle_secs: 86400, min_interval_secs: 300 }, { type: 'off' }]) {
    assert.deepEqual(await curl(`account-${policy.type}`, 'PUT', `${settingsPath}/account/cline`, policy), policy);
    assert.deepEqual((await curl(`account-${policy.type}-readback`, 'GET', settingsPath)).accounts.cline, policy);
    await stop();
    await start();
    assert.deepEqual((await curl(`account-${policy.type}-restart`, 'GET', settingsPath)).accounts.cline, policy);
  }
  await curl('invalid', 'PUT', `${settingsPath}/provider/cline`, { ...provider, idle_secs: 0 }, master, 400);
  const before = await curl('before-restart', 'GET', settingsPath);
  assert.deepEqual(before.providers.cline, provider);
  assert.equal(count(), 0, 'policy edits must not generate traffic');
  await stop();
  await start();
  assert.deepEqual(await curl('after-restart', 'GET', settingsPath), before);
  const scoped = await curl('create-scoped', 'POST', '/v0/management/scoped-keys', { name: 'warmup-fixture', allowed_providers: ['cline'] }, master, 201);
  for (const route of [settingsPath, '/v0/management/warmup/status']) await curl('scoped-denied', 'GET', route, undefined, scoped.api_key, 403);
  await curl('scoped-manual-denied', 'POST', '/admin/accounts/cline/warmup', undefined, scoped.api_key, 403);
  for (const scenario of ['valid', 'done', 'empty', 'error']) {
    mode = scenario;
    const result = await curl(`manual-${scenario}`, 'POST', '/admin/accounts/cline/warmup');
    assert.equal(result.ok, scenario === 'valid');
    assert.equal(result.stream_validated, scenario === 'valid');
    assert.equal(result.probed_model, 'z-ai/glm-5.3-flash');
  }
  for (const id of ['disabled', 'unsupported']) {
    const previous = count();
    assert.equal((await curl(`manual-${id}`, 'POST', `/admin/accounts/${id}/warmup`)).ok, false);
    assert.equal(count(), previous);
  }
  mode = 'cooldown';
  assert.equal((await curl('manual-429', 'POST', '/admin/accounts/cline/warmup')).status, 429);
  const previous = count();
  assert.equal((await curl('manual-cooldown-skip', 'POST', '/admin/accounts/cline/warmup')).detail, 'cooldown_model_quota');
  assert.equal(count(), previous);
  await curl('status-final', 'GET', '/v0/management/warmup/status');
  await fs.writeFile(path.join(evidence, 'summary.json'), JSON.stringify({ passed: true, results, captures }, null, 2));
  console.log(`PASS: ${results.length} literal curl checks; ${count()} mock generations; process restart persistence equal`);
} finally {
  await stop();
  mock.closeAllConnections();
  await new Promise(resolve => mock.close(resolve));
  await fs.writeFile(path.join(evidence, 'captures.json'), JSON.stringify(captures, null, 2));
  await fs.rm(temp, { recursive: true, force: true });
  console.log('Cleanup: disposable gateway, mock upstream, and isolated credentials removed');
}
