import { describe, expect, test } from 'bun:test';
import { PAIRED_SCHEMA, pairedHash, recomputePairedRound, aggregatePairedRounds, validatePairedContract } from '../qa/paired-contract.mjs';
import { pairedRuntimeEnvironment, pairedEnvelope } from '../qa/f4-paired.mjs';
import { balancedOrder } from '../../mahoquot-proxy/tools/bench/scripts/fair-translation.mjs';

const digest = value => pairedHash(JSON.stringify(value));
// Unit-only verifier: deliberately not exported as a production phase adapter.
const verifyPhase = (_id, events) => ({ passed: events.length === 1 && events[0].actual === events[0].expected, expected_failures: [] });
function fixture() {
  const files = new Map();
  const provenance = { run_id: 'unit-only', rounds: 2, seed: 35, config: { workload: 'unit-only' } };
  provenance.config_sha256 = digest(provenance.config);
  for (const side of ['baseline', 'candidate']) {
    const source = provenance[side] = { run_id: provenance.run_id, dirty: true, side,
      gateway_sha256: digest(side), gateway_source_sha256: digest('source'), gateway_revision: 'unit', build_command: 'cargo build', build_receipt: { sha256: digest('build') }, run_build_receipt: { path: '', sha256: '' } };
    const bytes = Buffer.from(JSON.stringify({ ...source, build_receipt_sha256: source.build_receipt.sha256, started_at: '2026-01-01T00:00:00Z', completed_at: '2026-01-01T00:00:01Z' }));
    source.run_build_receipt = { path: `${side}-build.json`, sha256: pairedHash(bytes) };
    files.set(source.run_build_receipt.path, bytes);
  }
  const receipt = { provenance, benchmarks: {} };
  for (let i = 0; i < 14; i++) {
    const id = `B${i}`;
    const pair = receipt.benchmarks[id] = { seed: 35, config_sha256: provenance.config_sha256 };
    for (const side of ['baseline', 'candidate']) {
      const rows = [];
      for (let round = 1; round <= 2; round++) {
        const raw = { schema: PAIRED_SCHEMA, id, side, round, run_id: provenance.run_id, seed: 35,
          order: balancedOrder(round, 35).map(tier => tier === 'B' ? 'baseline' : 'candidate'),
          config_sha256: provenance.config_sha256, provenance_sha256: digest(provenance[side]), failure: null, gateway_pid: 123,
          requests: [{ request_id: `${id}-${side}-${round}`, phase: id, status: 200, error: null, headers_ms: 1, content_ms: 2, end_ms: 3 }],
          resources: [{ pid: 123, phase: id, rss_bytes: 4096, fd_count: 3 }], phase_observations: [{ actual: 'x', expected: 'x' }] };
        const path = `${id}-${side}-${round}.json`, bytes = Buffer.from(JSON.stringify(raw));
        files.set(path, bytes);
        rows.push({ id, side, round, discarded: false, raw: path, raw_sha256: pairedHash(bytes), ...recomputePairedRound(raw, verifyPhase) });
      }
      pair[side] = { ...aggregatePairedRounds(rows), rounds: rows };
    }
  }
  const verified = [];
  const options = { verifyPhase, readBuild: async path => files.get(path), validateProvenance: async (_p, label) => { verified.push(label); }, readRaw: async (_root, path) => {
    if (!files.has(path)) throw new Error('missing raw');
    return files.get(path);
  } };
  return { receipt, files, options, verified };
}
function alterRaw(f, change) {
  const row = f.receipt.benchmarks.B0.candidate.rounds[0];
  const raw = JSON.parse(f.files.get(row.raw));
  change(raw);
  const bytes = Buffer.from(JSON.stringify(raw));
  f.files.set(row.raw, bytes); row.raw_sha256 = pairedHash(bytes);
}

test('collector environment drops ambient credentials and owns home/cache paths', () => {
  const env = pairedRuntimeEnvironment({ PATH: '/tools', HOME: '/host', HOME_JWT: 'secret', PGSTORE: 'hostdb', AWS_ACCESS_KEY_ID: 'secret', F4_BASELINE_BINARY: '/source/binary' }, '/owned/run');
  expect(env.HOME).toBe('/owned/run/home'); expect(env.XDG_CACHE_HOME).toBe('/owned/run/cache');
  expect(env.HOME_JWT).toBeUndefined(); expect(env.PGSTORE).toBeUndefined(); expect(env.AWS_ACCESS_KEY_ID).toBeUndefined();
  expect(env.F4_BASELINE_BINARY).toBe('/source/binary'); expect(env.PATH).toBe('/tools');
});
test('collector envelope binds inputs without changing raw failure observations', () => {
  const f = fixture(), phase = { requests: [{ error: 'abort' }], observations: { event: 'fault' } };
  const raw = pairedEnvelope({ id: 'B10', side: 'baseline', round: 1, provenance: f.receipt.provenance, phase, resources: [], failure: 'failed', gatewayPid: 123 });
  expect(raw.requests).toBe(phase.requests); expect(raw.failure).toBe('failed');
  expect(raw.provenance_sha256).toBe(digest(f.receipt.provenance.baseline));
  expect(raw.order).toEqual(balancedOrder(1, 35).map(tier => tier === 'B' ? 'baseline' : 'candidate'));
});

describe('paired raw contract (unit fixtures, not runtime evidence)', () => {
  test('recomputes all rounds and verifies both provenance closures', async () => {
    const f = fixture();
    await validatePairedContract('/unit', f.receipt, f.options);
    expect(f.verified).toEqual(['F4 baseline', 'F4 candidate']);
  });
  const mutations = {
    'swapped raw side': f => alterRaw(f, raw => { raw.side = 'baseline'; }),
    'wrong round': f => alterRaw(f, raw => { raw.round = 2; }),
    'wrong phase': f => alterRaw(f, raw => { raw.id = 'B1'; }),
    'wrong order': f => alterRaw(f, raw => { raw.order.reverse(); }),
    'wrong seed': f => alterRaw(f, raw => { raw.seed++; }),
    'stale run': f => alterRaw(f, raw => { raw.run_id = 'stale'; }),
    'wrong source binding': f => alterRaw(f, raw => { raw.provenance_sha256 = 'bad'; }),
    'wrong config binding': f => alterRaw(f, raw => { raw.config_sha256 = 'bad'; }),
    'synthetic': f => alterRaw(f, raw => { raw.synthetic = true; }),
    'unavailable': f => alterRaw(f, raw => { raw.requests = []; }),
    'missing phase evidence': f => alterRaw(f, raw => { raw.phase_observations = []; }),
    'failed correctness': f => alterRaw(f, raw => { raw.phase_observations[0].actual = 'bad'; }),
    'duplicate request': f => alterRaw(f, raw => { raw.requests.push(raw.requests[0]); }),
    'altered timing with fresh hash': f => alterRaw(f, raw => { raw.requests[0].end_ms = 4; }),
    'wrong resource process': f => alterRaw(f, raw => { raw.resources[0].pid = 124; }),
    'negative measured fd': f => alterRaw(f, raw => { raw.resources[0].fd_count = -1; }),
    'missing resource identity': f => alterRaw(f, raw => { delete raw.gateway_pid; }),
    'missing resource': f => alterRaw(f, raw => { raw.resources = []; }),
    'aggregate alteration': f => { f.receipt.benchmarks.B0.baseline.completion_ms++; },
    'missing round': f => { f.receipt.benchmarks.B0.baseline.rounds.pop(); },
    'duplicate round': f => { f.receipt.benchmarks.B0.baseline.rounds[1] = f.receipt.benchmarks.B0.baseline.rounds[0]; },
    'altered bytes': f => { f.files.set(f.receipt.benchmarks.B0.baseline.rounds[0].raw, Buffer.from('{}')); },
    'missing bytes': f => { f.files.delete(f.receipt.benchmarks.B0.baseline.rounds[0].raw); },
    'missing baseline build binding': f => { delete f.receipt.provenance.baseline.run_build_receipt; },
    'altered build bytes': f => { f.files.set('candidate-build.json', Buffer.from('{}')); },
    'dirty closure missing': f => { delete f.receipt.provenance.baseline.dirty; },
    'phase verifier unavailable': f => { delete f.options.verifyPhase; },
  };
  for (const [name, mutate] of Object.entries(mutations)) test(`rejects ${name}`, async () => {
    const f = fixture(); mutate(f);
    await expect(validatePairedContract('/unit', f.receipt, f.options)).rejects.toThrow();
  });
  test('retains real baseline failure and unavailable timings as null, not zero/pass', async () => {
    const f = fixture(), pair = f.receipt.benchmarks.B0;
    const row = pair.baseline.rounds[0], raw = JSON.parse(f.files.get(row.raw));
    raw.failure = 'gateway failed before request'; raw.requests = []; raw.resources = []; raw.phase_observations = [];
    const bytes = Buffer.from(JSON.stringify(raw)); f.files.set(row.raw, bytes);
    Object.assign(row, recomputePairedRound(raw, verifyPhase), { raw_sha256: pairedHash(bytes) });
    Object.assign(pair.baseline, aggregatePairedRounds(pair.baseline.rounds));
    await validatePairedContract('/unit', f.receipt, f.options);
    expect(row.passed).toBe(false);
    expect(row.ttfb_ms).toBeNull(); expect(pair.baseline.ttfb_ms).toBeNull();
    expect(row.failure).toBe('gateway failed before request');
  });
  test('expected admission has no invented content and expected abort retains raw error', () => {
    const f = fixture(), row = f.receipt.benchmarks.B0.candidate.rounds[0];
    const raw = JSON.parse(f.files.get(row.raw));
    raw.id = 'B11';
    raw.requests = [
      { request_id: 'accepted', phase: 'B11', status: 200, error: null, headers_ms: 0, content_ms: 1, end_ms: 2 },
      { request_id: 'refused', phase: 'B11', status: 503, error: null, headers_ms: 0, content_ms: null, end_ms: 1 },
      { request_id: 'aborted', phase: 'B11', status: 200, error: 'client aborted', headers_ms: 0, content_ms: 1, end_ms: 2 },
    ];
    raw.resources[0].phase = 'B11';
    const result = recomputePairedRound(raw, () => ({ passed: true, expected_failures: ['refused', 'aborted'] }));
    expect(result.errors).toBe(1); expect(result.expected_failures).toBe(2); expect(result.unexpected_errors).toBe(0);
    expect(result.observed_counts.content_ms).toBe(2);
    expect(raw.requests[1].content_ms).toBeNull(); expect(raw.requests[2].error).toBe('client aborted');
    const strict = recomputePairedRound(raw, () => ({ passed: true, expected_failures: [] }));
    expect(strict.unexpected_errors).toBe(2);
  });
  test('accepts observed zero timings and zero resource counts, not missing samples', async () => {
    const f = fixture(), pair = f.receipt.benchmarks.B0;
    alterRaw(f, raw => {
      Object.assign(raw.requests[0], { headers_ms: 0, content_ms: 0, end_ms: 0 });
      Object.assign(raw.resources[0], { rss_bytes: 0, fd_count: 0 });
    });
    const row = pair.candidate.rounds[0];
    Object.assign(row, recomputePairedRound(JSON.parse(f.files.get(row.raw)), verifyPhase));
    Object.assign(pair.candidate, aggregatePairedRounds(pair.candidate.rounds));
    await validatePairedContract('/unit', f.receipt, f.options);
    expect(row.ttfb_ms).toBe(0); expect(row.fd_count).toBe(0); expect(row.unavailable).toBe(false);
    alterRaw(f, raw => { raw.resources = []; });
    await expect(validatePairedContract('/unit', f.receipt, f.options)).rejects.toThrow();
  });
});
