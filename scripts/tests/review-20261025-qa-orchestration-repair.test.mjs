import { test, expect } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { countAccountHops, benchmarkOwner, bounded } from '../bench-locality.mjs';
import { noCommittedReplay, usedCredential } from '../bench-resilience.mjs';
import { localityVerdicts, candidateTrialObserved, summarize } from '../qa/f4-paired.mjs';
import { routeObserved } from '../qa/f1-inventory.mjs';
import { auditInternals } from '../qa/cliproxy-audit.mjs';

test('adjacent account changes are counted and reject B3 rebinds', () => {
  for (const [accounts, expected] of [[[], 0], [['A'], 0], [['A', 'A', 'A'], 0], [['A', 'B', 'A'], 2]]) {
    expect(countAccountHops(accounts.map(account => ({ account })))).toBe(expected);
  }
  const b3 = { rounds: 5, signature_recall_success: true, raw_routing_headers_leaked: 0, hops: 5, rebind_count: 0, prompt_tokens_growth: [1, 2, 3, 4, 5], p50_ms: 1 };
  expect(localityVerdicts({ b3_history: b3 }).B3).toBe(true);
  expect(localityVerdicts({ b3_history: { ...b3, rebind_count: countAccountHops(['A', 'B', 'A'].map(account => ({ account }))) } }).B3).toBe(false);
});

test('logical replay and wrong credential cannot become success', () => {
  const entries = [0, 1].map(i => ({ id: `b7-failover-${i}`, status: 200, authHeader: 'Bearer new' }));
  expect(noCommittedReplay(entries, 'b7-failover-', 2)).toBe(true);
  expect(noCommittedReplay([...entries, entries[0]], 'b7-failover-', 2)).toBe(false);
  expect(noCommittedReplay([{ id: null, status: 200 }], 'b7-failover-', 1)).toBe(false);
  expect(usedCredential(entries, 'b7-failover-0', 'new')).toBe(true);
  expect(usedCredential(entries, 'b7-failover-0', 'old')).toBe(false);
});

test('candidate correctness requires observations, baseline failure remains collectable', () => {
  const good = { passed: true, unavailable: false, failure: null, errors: 0, request_count: 1, ttfb_ms: 1, content_ttft_ms: 1, completion_ms: 1, rss_bytes: 1, fd_count: 1 };
  expect(candidateTrialObserved(good)).toBe(true);
  for (const mutation of [{ unavailable: true }, { errors: 1 }, { passed: false }, { request_count: 0 }, { rss_bytes: 0 }, { failure: 'unready' }]) expect(candidateTrialObserved({ ...good, ...mutation })).toBe(false);
  const unavailable = summarize({ suite: 'resilience', requests: [], stats: {}, report: { correctness_passed: false }, failure: 'unsupported' }, 'B10');
  expect(unavailable.unavailable).toBe(true);
  expect(candidateTrialObserved(unavailable)).toBe(false);
});

test('transport failures and invented setting observations cannot certify', async () => {
  expect(routeObserved({ status: null, transport_error: 'ECONNREFUSED' })).toBe(false);
  expect(routeObserved({ status: 500 })).toBe(false);
  expect(routeObserved({ status: 200 })).toBe(true);
  const dir = await mkdtemp(join(tmpdir(), 'qao-inventory-'));
  try {
    await writeFile(join(dir, 'setting-inventory.json'), JSON.stringify({ kind: 'setting', source_revision: 'fixture', source_sha256: 'a'.repeat(64), entries: ['proxy', 'retry', 'quota'].map(id => ({ id, source_path: 'settings.rs', observed: { key: id, verified: true }, pass: true })) }));
    await expect(auditInternals.validateInventory(dir, 'setting')).rejects.toThrow('setting readback missing');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('first-allocation failure reaps live unready child and releases listener', async () => {
  const owner = benchmarkOwner();
  let child;
  try {
    owner.serve({ hostname: '127.0.0.1', port: 18858, fetch: () => new Response('fixture') });
    const run = owner.spawn([process.execPath, '-e', 'console.error("listening fixture"); await new Promise(() => {});'], { stdout: 'pipe', stderr: 'pipe' });
    child = run.child;
    await bounded(run.listening, 'fixture startup');
    await expect(bounded(new Promise(() => {}), 'failed readiness', 1)).rejects.toThrow('deadline');
  } finally { await owner.close(); }
  await child.exited;
  let probeError;
  try { process.kill(child.pid, 0); } catch (error) { probeError = error; }
  expect(probeError?.code).toBe('ESRCH');
  const rebound = Bun.listen({ hostname: '127.0.0.1', port: 18858, socket: { data() {} } });
  rebound.stop(true);
});
