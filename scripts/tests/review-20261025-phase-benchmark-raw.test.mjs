import { test } from 'node:test';
import assert from 'node:assert/strict';
import { phaseObservations, localityPhaseCollector, localityFailoverFault, retainLocalityReport } from '../bench-locality.mjs';

const bytes = text => new TextEncoder().encode(text);
const marker = (phase, pid = 42) => `MAHOQUOT_BENCH_PHASE ${JSON.stringify({ phase, pid, event: 'entered' })}`;

test('nonzero driver retains native failed attempts before missing phase failure', async () => {
  const evidence = phaseObservations();
  const report = { phases: { B3: { requests: [{ request_id: 'B3:0', headers_ms: 2, content_ms: null, end_ms: 3, error: 'reset' }], failure: 'reset' }, B4: { requests: [], failure: 'not attempted' } } };
  await assert.rejects(retainLocalityReport({ readReport: async () => JSON.stringify(report), exitCode: 1, output: 'failed', evidence,
    finishPhases: () => { throw new Error('missing phases'); } }), error => {
    assert.deepEqual(error.native_report, report);
    assert.equal(error.raw_observations, evidence.raw);
    assert.match(error.message, /bench locality failed \(1\)/);
    assert.match(error.message, /missing phases/);
    return true;
  });
  assert.deepEqual(JSON.parse(JSON.stringify(evidence.raw)).native_report, report);
  assert.equal(evidence.raw.native_exit_code, 1);
});

test('invalid and missing native reports preserve nonzero failure without fabricated report', async () => {
  for (const readReport of [async () => '{invalid', async () => { throw new Error('ENOENT'); }]) {
    const evidence = phaseObservations();
    await assert.rejects(retainLocalityReport({ readReport, exitCode: 2, output: 'driver failure', evidence, finishPhases: () => {} }), error => {
      assert.equal(error.native_report, null);
      assert.match(error.message, /bench locality failed \(2\)/);
      assert.match(error.message, /native report unavailable/);
      return true;
    });
    assert.equal(Object.hasOwn(evidence.raw, 'native_report'), false);
    assert.equal(typeof evidence.raw.native_report_error, 'string');
  }
});

test('successful report augmentation cannot create raw report cycles', async () => {
  const evidence = phaseObservations();
  const report = await retainLocalityReport({ readReport: async () => '{"phases":{}}', exitCode: 0, output: '', evidence, finishPhases: () => {} });
  report.raw_observations = evidence.raw;
  assert.deepEqual(JSON.parse(JSON.stringify(report)).raw_observations.native_report, { phases: {} });
});

test('correlated failover faults the observed bound route A once, never route B or alternate', () => {
  const fault = localityFailoverFault();
  const input = (model, credential, content) => ({ model, credential, messages: [{ role: 'user', content }] });
  const probe = 'alternating route test request_id=B4:2 step=3 fault=bound-a';
  assert.equal(fault(input('gpt-5.6-sol', 'observed-a', probe)), false);
  assert.equal(fault(input('gpt-5.6-sol', 'observed-a', 'alternating route test request_id=B4:0 step=1')), false);
  assert.equal(fault(input('claude-sonnet-4', 'observed-b', probe)), false);
  assert.equal(fault(input('gpt-5.6-sol', 'alternate', probe)), false);
  assert.equal(fault(input('gpt-5.6-sol', 'observed-a', probe)), true);
  assert.equal(fault(input('gpt-5.6-sol', 'observed-a', probe)), false);
  assert.equal(fault(input('gpt-5.6-sol', 'alternate', probe)), false);
});

test('phase acknowledgement waits for actual owned PID measurement', async () => {
  const evidence = phaseObservations();
  let release;
  const measurement = new Promise(resolve => { release = resolve; });
  const acknowledgements = [];
  const collector = localityPhaseCollector({ pid: 42, evidence,
    measure: pid => { assert.equal(pid, 42); return measurement; },
    acknowledge: line => acknowledgements.push(line), wall: () => 10 });
  const pending = collector.line(marker('B3'), 'stderr');
  assert.equal(acknowledgements.length, 0);
  assert.equal(evidence.raw.resources.length, 0);
  release({ rssBytes: 123, fds: 7 });
  await pending;
  assert.deepEqual(evidence.raw.resources[0], { phase: 'B3', pid: 42, marker_received_at: 10, observed_at: 10, sample_kind: 'held-phase-entry', rss_bytes: 123, fd_count: 7, errors: [] });
  assert.equal(acknowledgements[0], 'MAHOQUOT_BENCH_PHASE_ACK {"phase":"B3","pid":42}\n');
});

test('missing support and invalid marker identities never create fallback samples', async () => {
  for (const line of [marker('B3', 99), marker('B4'), 'MAHOQUOT_BENCH_PHASE invalid']) {
    const evidence = phaseObservations();
    const collector = localityPhaseCollector({ pid: 42, evidence,
      measure: () => assert.fail('invalid marker measured'), acknowledge: () => assert.fail('invalid marker acknowledged') });
    await assert.rejects(collector.line(line, 'stderr'));
    assert.equal(evidence.raw.resources.length, 0);
    assert.equal(evidence.raw.events.at(-1).event, 'phase-protocol-error');
  }
  const evidence = phaseObservations();
  const collector = localityPhaseCollector({ pid: 42, evidence, measure: () => assert.fail(), acknowledge: () => assert.fail() });
  await collector.line(marker('B3'), 'stdout');
  assert.throws(() => collector.finish());
  assert.deepEqual(evidence.raw.phase_resource_support.missing_phases, ['B3', 'B4', 'B5', 'B8', 'B9']);
});

test('null resource measurements survive all phase entries without zero filling', async () => {
  const evidence = phaseObservations();
  const collector = localityPhaseCollector({ pid: 42, evidence, measure: async () => ({ rssBytes: null, fds: null }), acknowledge: () => {} });
  for (const phase of ['B3', 'B4', 'B5', 'B8', 'B9']) await collector.line(marker(phase), 'stderr');
  collector.finish();
  assert.equal(evidence.raw.resources.length, 5);
  assert.ok(evidence.raw.resources.every(row => row.rss_bytes === null && row.fd_count === null && row.errors.length === 2));
  await assert.rejects(collector.line(marker('B9'), 'stderr'));
});

test('measurement failure records protocol failure and never acknowledges', async () => {
  const evidence = phaseObservations();
  const collector = localityPhaseCollector({ pid: 42, evidence, measure: async () => { throw new Error('helper cleanup failed'); }, acknowledge: () => assert.fail() });
  await assert.rejects(collector.line(marker('B3'), 'stderr'), /helper cleanup failed/);
  assert.equal(evidence.raw.resources.length, 0);
  assert.match(evidence.raw.events.at(-1).error, /helper cleanup failed/);
});

test('phase attempts retain failed and unavailable measurements without zero filling', () => {
  let now = 10;
  const evidence = phaseObservations({ clock: () => now, wall: () => 123 });
  const failed = evidence.begin('B6', 'burst-0');
  now = 13;
  failed.fail(new Error('connection refused'));
  const pending = evidence.begin('B7', 'failover-0');
  assert.deepEqual(evidence.raw.requests.map(({ phase, headers_ms, content_ms, end_ms, error }) => ({ phase, headers_ms, content_ms, end_ms, error })), [
    { phase: 'B6', headers_ms: null, content_ms: null, end_ms: 3, error: 'connection refused' },
    { phase: 'B7', headers_ms: null, content_ms: null, end_ms: null, error: null },
  ]);
  assert.notEqual(failed.row.request_id, pending.row.request_id);
});

test('semantic content timing excludes transport and role frames and handles split data', () => {
  let now = 0;
  const evidence = phaseObservations({ clock: () => now, wall: () => 123 });
  const attempt = evidence.begin('B8', 'inflight');
  now = 2; attempt.headers(200);
  now = 3; attempt.chunk(bytes('data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n'));
  assert.equal(attempt.row.content_ms, null);
  now = 4; attempt.chunk(bytes('data: {"choices":[{"delta":{"content":"'));
  now = 6; attempt.chunk(bytes('x"}}]}\n\n'));
  now = 9; attempt.end();
  assert.equal(attempt.row.headers_ms, 2);
  assert.equal(attempt.row.content_ms, 6);
  assert.equal(attempt.row.end_ms, 9);
  assert.match(attempt.row.response_body, /"content":"x"/);
});

test('observed fetch records status, body, transport failure and distinct attempts', async () => {
  let now = 0;
  const evidence = phaseObservations({ clock: () => ++now, wall: () => 123 });
  const wrapped = evidence.observeFetch(async input => {
    if (input === 'failure') throw new Error('transport failure');
    return new Response('data: {"type":"response.output_text.delta","delta":"ok"}\n\n', { status: 200 });
  }, () => ({ phase: 'B13', id: 'telemetry-0' }));
  assert.match(await (await wrapped('success')).text(), /"delta":"ok"/);
  await assert.rejects(wrapped('failure'), /transport failure/);
  const [success, failed] = evidence.raw.requests;
  assert.equal(success.status, 200);
  assert.ok(success.content_ms >= success.headers_ms);
  assert.ok(success.end_ms >= success.content_ms);
  assert.equal(failed.status, null);
  assert.equal(failed.error, 'transport failure');
  assert.equal(evidence.raw.events.length, 2);
});

test('HTTP errors are retained as status, not fabricated transport failures or content', async () => {
  const evidence = phaseObservations();
  const wrapped = evidence.observeFetch(async () => new Response('{"error":"capacity"}', { status: 503 }), () => ({ phase: 'B11', id: 'ceiling-0' }));
  await (await wrapped('http://fixture.invalid')).text();
  assert.equal(evidence.raw.requests[0].status, 503);
  assert.equal(evidence.raw.requests[0].content_ms, null);
  assert.equal(evidence.raw.requests[0].error, null);
  assert.equal(evidence.raw.requests[0].response_body, '{"error":"capacity"}');
});
