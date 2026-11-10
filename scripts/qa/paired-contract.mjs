import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { balancedOrder } from '../../mahoquot-proxy/tools/bench/scripts/fair-translation.mjs';

export const PAIRED_SCHEMA = 'mahoquot/paired-raw-v2';
export const pairedHash = value => createHash('sha256').update(value).digest('hex');
const digest = value => pairedHash(JSON.stringify(value));
const metrics = ['ttfb_ms', 'content_ttft_ms', 'completion_ms', 'rss_bytes', 'fd_count'];
const ids = Array.from({ length: 14 }, (_, i) => `B${i}`);
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const average = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
const peak = values => values.length ? Math.max(...values) : null;
const measured = (requests, key) => requests.map(request => request[key]).filter(value => value !== null);

// This is intentionally not a report-flag adapter. Producers must supply raw
// phase evidence and a phase-specific verifier before this gate can certify it.
export function recomputePairedRound(raw, verifyPhase) {
  assert.equal(raw.schema, PAIRED_SCHEMA, 'raw request observations unavailable');
  assert.notEqual(raw.synthetic, true, 'synthetic raw');
  assert.equal(typeof verifyPhase, 'function', 'raw phase verifier unavailable');
  assert.ok(ids.includes(raw.id), 'phase identity');
  assert.ok(raw.failure === null || (typeof raw.failure === 'string' && raw.failure.length > 0), 'failure observation');
  assert.ok(Array.isArray(raw.requests) && Array.isArray(raw.resources), 'raw observations missing');
  const seen = new Set();
  for (const request of raw.requests) {
    assert.ok(typeof request.request_id === 'string' && request.request_id && !seen.has(request.request_id), 'duplicate/missing request identity');
    seen.add(request.request_id);
    assert.equal(request.phase, raw.id, 'request phase mismatch');
    assert.ok(request.error === null || (typeof request.error === 'string' && request.error.length > 0), 'request outcome missing');
    for (const key of ['headers_ms', 'content_ms', 'end_ms']) assert.ok(request[key] === null || number(request[key]), `invalid ${key}`);
    if (request.headers_ms !== null && request.content_ms !== null) assert.ok(request.headers_ms <= request.content_ms, 'timing order');
    if (request.content_ms !== null && request.end_ms !== null) assert.ok(request.content_ms <= request.end_ms, 'timing order');
  }
  for (const resource of raw.resources) {
    assert.ok(Number.isInteger(raw.gateway_pid) && raw.gateway_pid > 0, 'gateway resource identity missing');
    assert.equal(resource.pid, raw.gateway_pid, 'resource belongs to another process');
    assert.equal(resource.phase, raw.id, 'resource phase mismatch');
    assert.ok(Number.isInteger(resource.pid) && resource.pid > 0 && (resource.rss_bytes === null || number(resource.rss_bytes)) && (resource.fd_count === null || (Number.isInteger(resource.fd_count) && resource.fd_count >= 0)), 'invalid resource observation');
  }
  const verdict = raw.failure === null ? verifyPhase(raw.id, raw.phase_observations, raw.requests) : { passed: false, expected_failures: [] };
  assert.ok(verdict && typeof verdict.passed === 'boolean' && Array.isArray(verdict.expected_failures), 'phase classification missing');
  const expected = new Set(verdict.expected_failures);
  assert.equal(expected.size, verdict.expected_failures.length, 'duplicate expected failure identity');
  assert.ok([...expected].every(id => seen.has(id)), 'unknown expected failure identity');
  const unexpected = raw.requests.filter(request => !expected.has(request.request_id) &&
    (request.error !== null || !Number.isInteger(request.status) || request.status < 200 || request.status >= 300 || !['headers_ms', 'content_ms', 'end_ms'].every(key => number(request[key]))));
  const completeExpected = raw.requests.filter(request => expected.has(request.request_id)).every(request => number(request.headers_ms) && number(request.end_ms));
  return {
    samples: 1, passed: verdict.passed && completeExpected && raw.failure === null, unavailable: raw.requests.length === 0,
    unexpected_errors: unexpected.length, expected_failures: expected.size,
    request_count: raw.requests.length, errors: raw.requests.filter(request => request.error !== null).length,
    ttfb_ms: average(measured(raw.requests, 'headers_ms')),
    content_ttft_ms: average(measured(raw.requests, 'content_ms')),
    completion_ms: average(measured(raw.requests, 'end_ms')),
    rss_bytes: peak(raw.resources.map(resource => resource.rss_bytes).filter(number)),
    fd_count: peak(raw.resources.map(resource => resource.fd_count).filter(number)),
    observed_counts: Object.fromEntries(['headers_ms', 'content_ms', 'end_ms'].map(key => [key, measured(raw.requests, key).length])),
    failure: raw.failure,
  };
}

export function aggregatePairedRounds(rows) {
  assert.ok(rows.length > 0, 'missing rounds');
  const aggregate = {
    unexpected_errors: rows.reduce((sum, row) => sum + row.unexpected_errors, 0), expected_failures: rows.reduce((sum, row) => sum + row.expected_failures, 0),
    samples: rows.length, errors: rows.reduce((sum, row) => sum + row.errors, 0),
    request_count: rows.reduce((sum, row) => sum + row.request_count, 0),
    unavailable_rounds: rows.filter(row => row.unavailable).length,
  };
  for (const key of metrics) aggregate[key] = rows.some(row => row[key] === null) ? null :
    (key === 'rss_bytes' || key === 'fd_count' ? peak : average)(rows.map(row => row[key]));
  return aggregate;
}

async function readBound(root, path) {
  assert.ok(typeof path === 'string' && path.length > 0, 'missing raw path');
  const base = await realpath(root);
  const target = await realpath(resolve(base, path));
  assert.ok(target.startsWith(base + sep), 'raw path escapes evidence root');
  return readFile(target);
}

export async function validatePairedBuildReceipt(source, read = readFile) {
  const reference = source.run_build_receipt;
  assert.ok(reference?.path && reference.sha256, 'run build receipt missing');
  const bytes = await read(reference.path);
  assert.equal(pairedHash(bytes), reference.sha256, 'run build receipt hash mismatch');
  const build = JSON.parse(bytes);
  for (const key of ['run_id', 'gateway_sha256', 'gateway_source_sha256', 'gateway_revision', 'dirty', 'build_command']) {
    assert.ok(Object.hasOwn(source, key), `build source ${key} missing`);
    assert.deepEqual(build[key], source[key], `run build ${key} mismatch`);
  }
  assert.equal(build.build_receipt_sha256, source.build_receipt?.sha256, 'build receipt binding mismatch');
  assert.ok(typeof build.build_receipt_sha256 === 'string', 'build receipt binding missing');
  assert.ok(Number.isFinite(Date.parse(build.started_at)) && Number.isFinite(Date.parse(build.completed_at)) && Date.parse(build.completed_at) >= Date.parse(build.started_at), 'build lifecycle missing');
}

export async function validatePairedContract(root, receipt, { validateProvenance, verifyPhase, readRaw = readBound, readBuild = readFile } = {}) {
  assert.equal(typeof validateProvenance, 'function', 'source/build verifier unavailable');
  assert.equal(typeof verifyPhase, 'function', 'raw phase verifier unavailable');
  assert.notEqual(receipt.synthetic, true, 'synthetic receipt');
  const provenance = receipt.provenance;
  assert.ok(provenance && provenance.synthetic !== true, 'provenance missing/synthetic');
  assert.ok(typeof provenance.run_id === 'string' && provenance.run_id.length > 0, 'current run identity missing');
  assert.ok(Number.isInteger(provenance.rounds) && provenance.rounds > 0 && Number.isInteger(provenance.seed), 'round/seed missing');
  assert.ok(provenance.config && typeof provenance.config === 'object', 'config preimage missing');
  assert.equal(provenance.config_sha256, digest(provenance.config), 'config digest mismatch');
  for (const side of ['baseline', 'candidate']) {
    assert.equal(provenance[side]?.run_id, provenance.run_id, 'source/build current run mismatch');
    assert.equal(typeof provenance[side]?.dirty, 'boolean', 'dirty closure missing');
    await validateProvenance(provenance[side], `F4 ${side}`);
    await validatePairedBuildReceipt(provenance[side], readBuild);
  }
  const paths = new Set(), hashes = new Set();
  for (const id of ids) {
    const pair = receipt.benchmarks?.[id];
    assert.ok(pair, `missing ${id}`);
    assert.equal(pair.seed, provenance.seed, 'seed mismatch');
    assert.equal(pair.config_sha256, provenance.config_sha256, 'config mismatch');
    for (const side of ['baseline', 'candidate']) {
      const summary = pair[side];
      assert.ok(Array.isArray(summary?.rounds) && summary.rounds.length === provenance.rounds, 'missing paired rounds');
      const rows = [];
      for (let index = 0; index < provenance.rounds; index++) {
        const row = summary.rounds[index], round = index + 1;
        assert.equal(row.round, round, 'duplicate/missing/out-of-order round');
        assert.equal(row.side, side, 'swapped side');
        assert.equal(row.id, id, 'swapped phase');
        assert.equal(row.discarded, false, 'warmup round');
        assert.ok(!paths.has(row.raw) && !hashes.has(row.raw_sha256), 'duplicate raw round');
        paths.add(row.raw); hashes.add(row.raw_sha256);
        const bytes = await readRaw(root, row.raw);
        assert.equal(pairedHash(bytes), row.raw_sha256, 'raw hash mismatch');
        const raw = JSON.parse(bytes);
        const binding = { id, side, round, run_id: provenance.run_id, seed: provenance.seed,
          order: balancedOrder(round, provenance.seed).map(tier => tier === 'B' ? 'baseline' : 'candidate'),
          config_sha256: provenance.config_sha256, provenance_sha256: digest(provenance[side]) };
        for (const [key, value] of Object.entries(binding)) assert.deepEqual(raw[key], value, `raw ${key} mismatch`);
        const derived = recomputePairedRound(raw, verifyPhase);
        for (const [key, value] of Object.entries(derived)) assert.deepEqual(row[key], value, `round ${key} mismatch`);
        if (side === 'candidate') assert.ok(derived.passed && !derived.unavailable && derived.unexpected_errors === 0 && metrics.every(key => number(derived[key])), 'candidate failed/unavailable');
        rows.push(derived);
      }
      for (const [key, value] of Object.entries(aggregatePairedRounds(rows))) assert.deepEqual(summary[key], value, `aggregate ${key} mismatch`);
    }
  }
  return receipt;
}
