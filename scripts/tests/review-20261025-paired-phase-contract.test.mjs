import { expect, test } from 'bun:test';
import { verifyCancellationEvidence, verifyDurableEvidence, verifyPairedPhase, extractPairedPhase, verifyCoreBody } from '../qa/paired-phase-contract.mjs';

const coreExpected = { text: 'xx', input_tokens: 16, output_tokens: 2, cached_tokens: null, tool_arguments: null };
const coreBody = () => Array.from(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"xx"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":16,"completion_tokens":2}}\n\ndata: [DONE]\n\n'));
test('core body is independently parsed rather than trusting semantic flags', () => {
  expect(verifyCoreBody(coreBody(), coreExpected)).toBe(true);
  const requests = Array.from({ length: 10 }, (_, i) => ({ request_id: `B0:${i}`, phase: 'B0', status: 200, error: null, response_body: coreBody(), semantic_verified: false }));
  const evidence = { schema: 'mahoquot/core-requests-v1', expected: coreExpected, command: ['bench', 'run', '--phase', 'B0', '--total', '10', '--concurrency', '2', '--body-json', JSON.stringify({ bench_expect: { text: 'xx', input_tokens: 16, output_tokens: 2 } })] };
  expect(verifyPairedPhase('B0', evidence, requests).passed).toBe(true);
  requests[0].semantic_verified = true;
  requests[0].response_body = Array.from(new TextEncoder().encode('data: [DONE]\n\n'));
  expect(verifyPairedPhase('B0', evidence, requests).passed).toBe(false);
});
test('core rejects altered usage, duplicate terminal and truncated body', () => {
  expect(verifyCoreBody(coreBody(), { ...coreExpected, input_tokens: 17 })).toBe(false);
  expect(verifyCoreBody([...coreBody(), ...Array.from(new TextEncoder().encode('data: [DONE]\n\n'))], coreExpected)).toBe(false);
  expect(verifyCoreBody(coreBody().slice(0, -1), coreExpected)).toBe(false);
});

function cancellations() {
  const bindings = Array.from({ length: 100 }, (_, i) => ({ logical_id: `logical-${i}`, observation_id: `obs-${i}` }));
  const events = bindings.flatMap((binding, i) => [
    { event: 'request', observation_id: binding.observation_id, event_id: `event-${i}` },
    ...['guard-acquire', 'stream-open', 'guard-release', 'finalized', 'recorded'].map(event => ({ event, request_id: `event-${i}`, ...(event === 'finalized' ? { status: 499 } : {}) })),
  ]);
  return { bindings, events, upstream: bindings.map(binding => ({ event: 'upstream-cancel', logical_id: binding.logical_id })), in_flight_before: 0, in_flight_during: 100, in_flight_after: 0 };
}
function durable() {
  const observation_ids = Array.from({ length: 100 }, (_, i) => `obs-${i}`);
  const rows = observation_ids.map((_, i) => ({ event_id: `event-${i}` }));
  const events = observation_ids.map((id, i) => ({ event: 'request', observation_id: id, event_id: rows[i].event_id }));
  events.push({ event: 'commit', event_ids: rows.map(row => row.event_id), written: 100, rejected: 0, write_ms: 0, queue_depth: 0 });
  events.push({ event: 'flush', queue_depth: 0, dropped: 0, failures: 0, enqueued: 100, written: 100 });
  return { observation_ids, rows, events, shutdown_code: 0, drain_status: 200 };
}
test('B10 uses exact lifecycle order and observed in-flight snapshots', () => {
  const evidence = cancellations();
  expect(verifyCancellationEvidence(evidence)).toBe(true);
  evidence.events.push({ event: 'guard-release', request_id: 'event-0' });
  expect(verifyCancellationEvidence(evidence)).toBe(false);
});
test('B10 detects missing upstream cancellation despite report pass flags', () => {
  const evidence = cancellations(); evidence.upstream.pop(); evidence.passed = true;
  expect(verifyCancellationEvidence(evidence)).toBe(false);
});
test('B13 permits zero observed write latency and checks persisted identity', () => {
  const evidence = durable(); expect(verifyDurableEvidence(evidence)).toBe(true);
  evidence.rows[0].event_id = 'unrelated'; expect(verifyDurableEvidence(evidence)).toBe(false);
});
for (const [name, mutate] of Object.entries({
  duplicate: e => e.rows.push(e.rows[0]),
  missing_commit: e => e.events.splice(100, 1),
  missing_flush: e => e.events.pop(),
  failed_shutdown: e => { e.shutdown_code = 1; },
  incomplete_drain: e => { e.drain_status = 500; },
  duplicate_binding: e => { e.observation_ids[1] = e.observation_ids[0]; },
})) test(`B13 rejects ${name}`, () => { const evidence = durable(); mutate(evidence); expect(verifyDurableEvidence(evidence)).toBe(false); });
function refreshPhase() {
  const requests = Array.from({ length: 100 }, (_, i) => ({ request_id: `client-${i}`, logical_id: `b6-burst-${i}`, phase: 'B6', status: 200, error: null }));
  const phase_bindings = Object.fromEntries(requests.map((request, i) => [request.logical_id, `obs-${i}`]));
  return { requests, evidence: { schema: 'mahoquot/phase-observations-v1', phase_bindings,
    events: [{ phase: 'B6', event: 'refresh-request', response: { access_token: 'fresh', refresh_token: 'refresh' } }, { phase: 'B6', event: 'credential-file', value: { access_token: 'fresh', refresh_token: 'refresh' } }],
    upstream_executions: requests.map(request => ({ phase: 'B6', id: request.logical_id, status: 200, authHeader: 'Bearer fresh', observation_id: phase_bindings[request.logical_id] })) } };
}
for (const kind of ['wrong-token', 'duplicate-binding', 'duplicate-refresh', 'missing-client']) test(`B6 rejects ${kind}`, () => {
  const f = refreshPhase(); expect(verifyPairedPhase('B6', f.evidence, f.requests).passed).toBe(true);
  if (kind === 'wrong-token') f.evidence.upstream_executions[0].authHeader = 'Bearer stale';
  if (kind === 'duplicate-binding') f.evidence.phase_bindings['b6-burst-1'] = f.evidence.phase_bindings['b6-burst-0'];
  if (kind === 'missing-client') f.requests.pop();
  if (kind === 'duplicate-refresh') {
    f.evidence.events.push(f.evidence.events[0]);
    expect(() => verifyPairedPhase('B6', f.evidence, f.requests)).toThrow();
  } else expect(verifyPairedPhase('B6', f.evidence, f.requests).passed).toBe(false);
});

const telemetryBody = 'data: {"type":"response.output_text.delta","delta":"ok"}\n\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n';
function telemetryPhase() {
  const d = durable();
  const requests = d.observation_ids.map((_, i) => ({ request_id: `client-${i}`, logical_id: `b13-telemetry-${i}`, phase: 'B13', status: 200, error: null, response_body: telemetryBody }));
  return { requests, evidence: { schema: 'mahoquot/phase-observations-v1', lifecycle: d.events,
    phase_bindings: Object.fromEntries(requests.map((request, i) => [request.logical_id, d.observation_ids[i]])),
    events: [{ phase: 'B13', event: 'history-drain', status: 200 }, { phase: 'B13', event: 'persisted-telemetry', rows: d.rows, shutdown_code: 0 }] } };
}
for (const kind of ['missing', 'unrelated', 'duplicate']) test(`B13 rejects ${kind} client despite intact persistence`, () => {
  const f = telemetryPhase(); expect(verifyPairedPhase('B13', f.evidence, f.requests).passed).toBe(true);
  if (kind === 'missing') f.requests.pop();
  else f.requests[0].logical_id = kind === 'unrelated' ? 'unrelated' : f.requests[1].logical_id;
  expect(verifyPairedPhase('B13', f.evidence, f.requests).passed).toBe(false);
});
for (const body of ['', 'data: {"type":"response.output_text.delta","delta":"ok"}\n\n', 'data: {"type":"response.failed"}\n\n', telemetryBody.slice(0, -1)]) test(`B13 rejects incomplete downstream ${JSON.stringify(body)}`, () => {
  const f = telemetryPhase(); f.requests[0].response_body = body;
  expect(verifyPairedPhase('B13', f.evidence, f.requests).passed).toBe(false);
});
test('failed locality extraction retains native requests from the producer sidecar', () => {
  const native = [{ request_id: 'B4:0', error: 'observed failure' }];
  const raw = { failure: 'bench exit 1', report: null, raw_observations: { schema: 'mahoquot/phase-observations-v1', requests: [], events: [], native_report: { raw_schema: 'mahoquot/locality-requests-v1', phases: { B4: { requests: native, failure: 'actual phase failure' } } } } };
  expect(extractPairedPhase(raw, 'B4').requests).toEqual(native);
  expect(raw.report).toBeNull();
});
function switchPhase() {
  const before = 'b8-req-1-inflight-stream', after = 'b8-req-2-after-switch';
  const requests = Array.from({ length: 12 }, (_, i) => ({ request_id: `client-${i}`, logical_id: i === 0 ? before : i === 1 ? after : null, status: 200, error: null, response_body: coreBody() }));
  const events = [
    { event: 'upstream-request', request_id: before, config_generation: 1, proxy_listener: '127.0.0.1:18842' },
    { event: 'inflight-consumed', logical_id: before, body: 'data: {"choices":[{"delta":{"content":"x"}}]}\n\n' },
    { event: 'config-update', status: 200, yaml: 'proxy-url: "direct"\n' },
    { event: 'client-request', request_id: requests[1].request_id },
    { event: 'upstream-request', request_id: after, config_generation: 2, proxy_listener: null },
  ].map(event => ({ ...event, phase: 'B8' }));
  return { requests, evidence: { schema: 'mahoquot/phase-observations-v1', events, native_phase: { failure: null } } };
}
for (const kind of ['reordered', 'wrong-hop', 'truncated', 'missing-consumed']) test(`B8 rejects ${kind} switch evidence`, () => {
  const f = switchPhase(); expect(verifyPairedPhase('B8', f.evidence, f.requests).passed).toBe(true);
  if (kind === 'reordered') [f.evidence.events[1], f.evidence.events[2]] = [f.evidence.events[2], f.evidence.events[1]];
  if (kind === 'wrong-hop') f.evidence.events[4].proxy_listener = 'wrong';
  if (kind === 'truncated') f.requests[0].response_body.pop();
  if (kind === 'missing-consumed') {
    f.evidence.events.splice(1, 1);
    expect(() => verifyPairedPhase('B8', f.evidence, f.requests)).toThrow();
  } else expect(verifyPairedPhase('B8', f.evidence, f.requests).passed).toBe(false);
});

test('B4 and B9 derive account recovery and connection reuse from correlated executions', () => {
  for (const id of ['B4', 'B9']) {
    const accounts = id === 'B4' ? ['a', 'b', 'c', 'b', 'c', 'b'] : ['a', 'a', 'b', 'b'];
    const requests = accounts.map((_, i) => ({ request_id: `${id}:${i}`, status: 200, error: null, response_body: coreBody() }));
    const rows = accounts.map((account, i) => ({ phase: id, request_id: `${id}:${i}`, account, status: 200, connection_id: `socket-${account}` }));
    if (id === 'B4') rows.splice(2, 0, { phase: id, request_id: 'B4:2', account: 'a', status: 503, connection_id: 'socket-a' });
    const evidence = { schema: 'mahoquot/phase-observations-v1', events: [], workload_executions: rows, native_phase: { failure: null, upstream_executions: rows } };
    expect(verifyPairedPhase(id, evidence, requests).passed).toBe(true);
    if (id === 'B4') rows.splice(2, 1); else rows[1].connection_id = 'different';
    expect(verifyPairedPhase(id, evidence, requests).passed).toBe(false);
  }
});
test('B5 requires actual distinct tenant observation', () => {
  const requests = Array.from({ length: 5 }, (_, i) => ({ request_id: `B5:${i}`, status: 200, error: null, response_body: coreBody() }));
  const events = requests.map((_, i) => ({ phase: 'B5', event: 'upstream-request', credential: i === 4 ? 'tenant2-account' : 'parent-account', requested_tenant: i === 4 ? 'tenant2' : 'tenant1' }));
  const evidence = { schema: 'mahoquot/phase-observations-v1', events, native_phase: { failure: null } };
  expect(verifyPairedPhase('B5', evidence, requests).passed).toBe(true);
  events[4].credential = 'parent-account'; expect(verifyPairedPhase('B5', evidence, requests).passed).toBe(false);
});

test('B11 classifies only measured admission rejections after held-capacity proof', () => {
  const requests = Array.from({ length: 525 }, (_, i) => ({ request_id: `B11:${i}`, status: i < 512 ? 200 : 503, error: null }));
  const evidence = { schema: 'mahoquot/phase-observations-v1', events: [{ phase: 'B11', event: 'admission-peak', active_in_mock: 512, in_flight: 512 }], resources: [{ phase: 'B11', rss_bytes: 0 }] };
  expect(verifyPairedPhase('B11', evidence, requests).expected_failures).toHaveLength(13);
  evidence.events[0].in_flight = 511;
  expect(verifyPairedPhase('B11', evidence, requests).passed).toBe(false);
});
test('B12 rejects stale credential execution despite successful responses', () => {
  const requests = Array.from({ length: 5 }, (_, i) => ({ request_id: `client-${i}`, logical_id: `b12-traffic-${i}`, status: 200, error: null }));
  const events = requests.map((_, i) => ({ phase: 'B12', event: 'reload-response', iteration: i, status: 200, new_credential: `new-${i}`, removed_credentials: ['old'], observed_at: i }));
  const upstream_executions = requests.map((request, i) => ({ phase: 'B12', id: request.logical_id, status: 200, authHeader: `Bearer new-${i}`, time: i + 1 }));
  const evidence = { schema: 'mahoquot/phase-observations-v1', events, upstream_executions };
  expect(verifyPairedPhase('B12', evidence, requests).passed).toBe(true);
  upstream_executions[0].authHeader = 'Bearer old'; expect(verifyPairedPhase('B12', evidence, requests).passed).toBe(false);
});
function failoverPhase() {
  const requests = [], events = [{ phase: 'B7', event: 'admin-stats', value: { failed_over: 10, accounts: [{ id: 'burst', health: { status: 'cooldown' } }] } }], lifecycle = [], upstream_executions = [], phase_bindings = {};
  for (let i = 0; i < 10; i++) {
    for (const kind of ['failover', 'postcommit']) {
      const logical = `b7-${kind}-${i}`, observation = `obs-${kind}-${i}`, eventId = `event-${kind}-${i}`;
      phase_bindings[logical] = observation;
      requests.push({ request_id: logical, logical_id: logical, status: 200, error: kind === 'postcommit' ? 'stream failure' : null, response_body: 'data: {"delta":"committed"}\n\n' });
      lifecycle.push({ event: 'request', observation_id: observation, event_id: eventId }, { event: 'finalized', request_id: eventId }, { event: 'recorded', request_id: eventId });
      if (kind === 'failover') upstream_executions.push({ phase: 'B7', id: logical, observation_id: observation, status: 429 });
      upstream_executions.push({ phase: 'B7', id: logical, observation_id: observation, status: 200 });
      if (kind === 'postcommit') events.push(
        { phase: 'B7', event: 'downstream-commit', logical_id: logical, observation_id: observation, status: 200 },
        { phase: 'B7', event: 'postcommit-fault', logical_id: logical, observation_id: observation, action: 'upstream-controller-error' },
        { phase: 'B7', event: 'postcommit-drain', logical_id: logical, failure_observed: true });
    }
  }
  return { requests, evidence: { schema: 'mahoquot/phase-observations-v1', events, lifecycle, upstream_executions, phase_bindings } };
}
test('B7 accepts full workload stream rejection or translated error frame', () => {
  const f = failoverPhase(); expect(verifyPairedPhase('B7', f.evidence, f.requests).expected_failures).toHaveLength(10);
  for (const request of f.requests.filter(request => request.logical_id.includes('postcommit'))) { request.error = null; request.response_body += 'data: {"error":{"message":"upstream failure"}}\n\n'; }
  expect(verifyPairedPhase('B7', f.evidence, f.requests).passed).toBe(true);
});
for (const mutation of ['reduced', 'duplicate-logical', 'duplicate-observation', 'missing-drain', 'reordered-drain', 'missing-finalizer', 'reordered-finalizer', 'replay', 'missing-retry-success']) test(`B7 rejects ${mutation}`, () => {
  const f = failoverPhase(); expect(verifyPairedPhase('B7', f.evidence, f.requests).passed).toBe(true);
  if (mutation === 'reduced') f.requests.splice(2);
  if (mutation === 'duplicate-logical') f.requests[2].logical_id = f.requests[0].logical_id;
  if (mutation === 'duplicate-observation') f.evidence.phase_bindings['b7-failover-1'] = f.evidence.phase_bindings['b7-failover-0'];
  if (mutation === 'missing-drain') f.evidence.events.splice(3, 1);
  if (mutation === 'reordered-drain') [f.evidence.events[2], f.evidence.events[3]] = [f.evidence.events[3], f.evidence.events[2]];
  if (mutation === 'missing-finalizer') f.evidence.lifecycle.splice(4, 1);
  if (mutation === 'reordered-finalizer') [f.evidence.lifecycle[4], f.evidence.lifecycle[5]] = [f.evidence.lifecycle[5], f.evidence.lifecycle[4]];
  if (mutation === 'replay') f.evidence.upstream_executions.push(f.evidence.upstream_executions[2]);
  if (mutation === 'missing-retry-success') f.evidence.upstream_executions.splice(1, 1);
  expect(verifyPairedPhase('B7', f.evidence, f.requests).passed).toBe(false);
});

test('missing phase raw evidence never falls back to report verdict', () => {
  expect(() => extractPairedPhase({ report: { correctness_passed: true } }, 'B0')).toThrow();
  expect(() => verifyPairedPhase('B0', { correctness_passed: true }, [])).toThrow();
});
