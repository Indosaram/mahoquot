import assert from 'node:assert/strict';

// Producer reports are inputs, not verdicts. Each supported phase below reads
// raw events; adding a new producer schema requires an explicit adapter here.
export function extractPairedPhase(raw, id) {
  const retained = raw.native_report ?? raw.raw_observations?.native_report;
  if (!raw.report && retained) raw = { ...raw, report: { ...retained, raw_observations: raw.raw_observations } };
  if (raw.failure && !raw.report) {
    assert.ok(raw.raw_observations && Array.isArray(raw.raw_observations.requests), `${id} failed producer raw sidecar missing`);
    return { requests: raw.raw_observations.requests.filter(request => request.phase === id), observations: raw.raw_observations };
  }
  if (['B0', 'B1', 'B2'].includes(id)) {
    const report = raw.report?.[id];
    assert.equal(report?.request_schema, 'mahoquot/core-requests-v1', `${id} core raw requests missing`);
    assert.ok(Array.isArray(report.requests), 'core requests missing');
    const argv = report.client?.argv;
    assert.ok(Array.isArray(argv), 'core launched command missing');
    const argument = key => argv[argv.indexOf(key) + 1];
    assert.equal(argument('--phase'), id, 'core command phase mismatch');
    assert.equal(argument('--total'), '10', 'core command population mismatch');
    assert.equal(argument('--concurrency'), '2', 'core command concurrency mismatch');
    const body = JSON.parse(argument('--body-json'));
    assert.deepEqual(body.bench_expect, { text: 'xx', input_tokens: 16, output_tokens: 2 }, 'core command expectation mismatch');
    return { requests: report.requests, observations: { schema: report.request_schema, expected: report.expected, command: argv } };
  }
  const evidence = raw.report?.raw_observations ?? raw.raw_observations;
  if (['B3', 'B4', 'B5', 'B8', 'B9'].includes(id)) {
    assert.equal(raw.report?.raw_schema, 'mahoquot/locality-requests-v1', 'locality client raw missing');
    const phase = raw.report.phases?.[id];
    assert.ok(phase && Array.isArray(phase.requests), 'locality phase requests missing');
    assert.ok(evidence?.events, 'locality upstream events missing');
    return { requests: [...phase.requests, ...evidence.requests.filter(request => request.phase === id)], observations: { ...evidence, native_phase: phase } };
  }
  assert.equal(evidence?.schema, 'mahoquot/phase-observations-v1', `${id} raw phase observations missing`);
  assert.ok(Array.isArray(evidence.requests) && Array.isArray(evidence.events), 'raw request/event arrays missing');
  return { requests: evidence.requests.filter(request => request.phase === id), observations: evidence };
}

export function verifyCoreBody(bytes, expected) {
  if (!Array.isArray(bytes) || !bytes.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)) return false;
  let body;
  try { body = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes)); } catch { return false; }
  const frames = body.replaceAll('\r\n', '\n').split('\n\n');
  if (frames.pop().trim()) return false;
  let text = '', args = '', input = null, output = null, cached = null, terminal = false, done = false;
  for (const frame of frames) {
    const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
    if (!data) continue;
    if (data === '[DONE]') { if (done) return false; done = true; terminal = true; continue; }
    let value;
    try { value = JSON.parse(data); } catch { return false; }
    if (done || value.error || ['error', 'response.failed', 'response.incomplete'].includes(value.type)) return false;
    if (value.type?.startsWith('response.')) {
      if (value.type === 'response.output_text.delta') { if (terminal) return false; text += value.delta ?? ''; }
      if (value.type === 'response.function_call_arguments.delta') { if (terminal) return false; args += value.delta ?? ''; }
      if (value.type === 'response.completed') {
        if (terminal) return false; terminal = true;
        input = value.response?.usage?.input_tokens; output = value.response?.usage?.output_tokens;
      }
    } else if (value.type?.startsWith('message_') || value.type?.startsWith('content_block_')) {
      if (value.type === 'message_start') input = value.message?.usage?.input_tokens;
      if (value.type === 'content_block_delta') { if (terminal) return false; text += value.delta?.text ?? ''; args += value.delta?.partial_json ?? ''; }
      if (value.type === 'message_delta') { output = value.usage?.output_tokens ?? output; input = value.usage?.input_tokens ?? input; }
      if (value.type === 'message_stop') { if (terminal) return false; terminal = true; }
    } else {
      for (const choice of value.choices ?? []) {
        if (terminal && (choice.delta?.content || choice.delta?.tool_calls?.length)) return false;
        text += choice.delta?.content ?? '';
        for (const call of choice.delta?.tool_calls ?? []) args += call.function?.arguments ?? '';
        if (choice.finish_reason != null) { if (terminal) return false; terminal = true; }
      }
      if (value.usage) {
        input = value.usage.prompt_tokens ?? value.usage.input_tokens;
        output = value.usage.completion_tokens ?? value.usage.output_tokens;
        cached = value.usage.prompt_tokens_details?.cached_tokens ?? null;
      }
    }
  }
  return terminal && text === expected.text && input === expected.input_tokens && output === expected.output_tokens
    && (expected.cached_tokens == null || cached === expected.cached_tokens) && (expected.tool_arguments == null || args === expected.tool_arguments);
}

function lifecycle(events, observationId, name) {
  const bindings = events.filter(event => event.event === 'request' && event.observation_id === observationId);
  if (bindings.length !== 1) return [];
  return events.filter(event => event.event === name && event.request_id === bindings[0].event_id);
}

export function verifyCancellationEvidence(evidence) {
  const { events, bindings, upstream, in_flight_before: before, in_flight_during: during, in_flight_after: after } = evidence;
  assert.ok(Array.isArray(events) && Array.isArray(bindings) && Array.isArray(upstream), 'B10 raw lifecycle missing');
  assert.ok([before, during, after].every(value => Number.isSafeInteger(value) && value >= 0), 'B10 in-flight snapshots missing');
  if (bindings.length < 100 || new Set(bindings.map(binding => binding.observation_id)).size !== bindings.length || new Set(bindings.map(binding => binding.logical_id)).size !== bindings.length) return false;
  return during >= before + bindings.length && after === before && bindings.every(binding => {
    const groups = ['guard-acquire', 'stream-open', 'guard-release', 'finalized', 'recorded'].map(name => lifecycle(events, binding.observation_id, name));
    return groups.every(group => group.length === 1) && groups[3][0].status === 499
      && groups.every((group, index) => index === 0 || events.indexOf(group[0]) > events.indexOf(groups[index - 1][0]))
      && upstream.filter(event => event.event === 'upstream-cancel' && event.logical_id === binding.logical_id).length === 1;
  });
}

export function verifyDurableEvidence(evidence) {
  const { events, observation_ids: observations, rows, shutdown_code: shutdown, drain_status: drain } = evidence;
  assert.ok(Array.isArray(events) && Array.isArray(observations) && Array.isArray(rows), 'B13 raw persistence missing');
  if (shutdown !== 0 || drain !== 200 || observations.length < 100 || new Set(observations).size !== observations.length) return false;
  const bindings = observations.map(id => events.filter(event => event.event === 'request' && event.observation_id === id));
  if (bindings.some(group => group.length !== 1)) return false;
  const ids = bindings.map(group => group[0].event_id);
  if (new Set(ids).size !== ids.length) return false;
  const commits = ids.map(id => events.filter(event => event.event === 'commit' && Array.isArray(event.event_ids) && event.event_ids.includes(id)));
  if (!commits.every(group => group.length === 1 && group[0].written === group[0].event_ids.length && group[0].rejected === 0
    && Number.isFinite(group[0].write_ms) && group[0].write_ms >= 0 && Number.isSafeInteger(group[0].queue_depth) && group[0].queue_depth >= 0)) return false;
  const flush = events.filter(event => event.event === 'flush').at(-1);
  return ids.every(id => rows.filter(row => row.event_id === id).length === 1) && Boolean(flush)
    && events.indexOf(flush) > Math.max(...commits.map(group => events.indexOf(group[0])))
    && flush.queue_depth === 0 && flush.dropped === 0 && flush.failures === 0
    && Number.isSafeInteger(flush.enqueued) && flush.enqueued >= ids.length && flush.enqueued === flush.written;
}

export function verifyPairedPhase(id, evidence, requests) {
  const passed = phasePassed(id, evidence, requests);
  // Expected faults stay in raw errors; only this trusted classifier permits them.
  const expected = passed ? requests.filter(request =>
    (id === 'B11' && request.status === 503 && request.error === null) ||
    (id === 'B10' && request.logical_id?.startsWith('b10-abort-')) ||
    (id === 'B7' && request.logical_id?.startsWith('b7-postcommit-'))).map(request => request.request_id) : [];
  return { passed, expected_failures: expected };
}

function phasePassed(id, evidence, requests) {
  assert.ok(evidence && Array.isArray(requests), `${id} phase evidence missing`);
  if (['B0', 'B1', 'B2'].includes(id)) {
    assert.equal(evidence.schema, 'mahoquot/core-requests-v1', 'core schema mismatch');
    assert.deepEqual(evidence.expected, { text: 'xx', input_tokens: 16, output_tokens: 2, cached_tokens: null, tool_arguments: null }, 'core expected workload changed');
    assert.ok(Array.isArray(evidence.command), 'core command binding missing');
    const arg = key => evidence.command[evidence.command.indexOf(key) + 1];
    assert.equal(arg('--phase'), id); assert.equal(arg('--total'), '10'); assert.equal(arg('--concurrency'), '2');
    assert.deepEqual(JSON.parse(arg('--body-json')).bench_expect, { text: 'xx', input_tokens: 16, output_tokens: 2 });
    return requests.length === 10 && requests.every((request, index) => request.request_id === `${id}:${index}` && request.phase === id
      && request.status === 200 && request.error === null && verifyCoreBody(request.response_body, evidence.expected));
  }
  assert.equal(evidence.schema, 'mahoquot/phase-observations-v1', 'raw phase schema mismatch');
  const events = evidence.events.filter(event => event.phase === id);
  const one = name => {
    const matches = events.filter(event => event.event === name);
    assert.equal(matches.length, 1, `${id} ${name} observation missing/duplicate`);
    return matches[0];
  };
  const executions = evidence.upstream_executions?.filter(event => event.phase === id);
  if (id === 'B10') {
    const snapshot = one('in-flight-snapshots');
    const bindings = Object.entries(evidence.phase_bindings ?? {}).filter(([logical]) => logical.startsWith('b10-abort-'));
    if (requests.length !== bindings.length || new Set(requests.map(request => request.logical_id)).size !== bindings.length || !requests.every(request => bindings.some(([logical]) => logical === request.logical_id) && request.status === 200)) return false;
    return verifyCancellationEvidence({ events: evidence.lifecycle,
      bindings: bindings.map(([logical_id, observation_id]) => ({ logical_id, observation_id })),
      upstream: evidence.lifecycle, in_flight_before: snapshot.before, in_flight_during: snapshot.during, in_flight_after: snapshot.after });
  }
  if (id === 'B13') {
    const persisted = one('persisted-telemetry');
    const drain = one('history-drain');
    const bindings = Object.entries(evidence.phase_bindings ?? {}).filter(([logical]) => logical.startsWith('b13-telemetry-'));
    if (requests.length !== 100 || bindings.length !== requests.length || new Set(bindings.map(([, observation]) => observation)).size !== requests.length
      || new Set(requests.map(request => request.logical_id)).size !== requests.length
      || !requests.every(request => request.phase === id && request.status === 200 && request.error === null && bindings.some(([logical]) => logical === request.logical_id)
        && typeof request.response_body === 'string' && verifyCoreBody(Array.from(new TextEncoder().encode(request.response_body)), { text: 'ok', input_tokens: 1, output_tokens: 1 }))) return false;
    return verifyDurableEvidence({ events: evidence.lifecycle,
      observation_ids: bindings.map(([, observation]) => observation),
      rows: persisted.rows, shutdown_code: persisted.shutdown_code, drain_status: drain.status });
  }
  if (['B4', 'B5', 'B9'].includes(id)) {
    if (evidence.native_phase?.failure) return false;
    const count = { B4: 6, B5: 5, B9: 4 }[id];
    if (requests.length !== count || !requests.every(request => request.status === 200 && request.error === null && verifyCoreBody(request.response_body, { text: 'xx', input_tokens: 16, output_tokens: 2 }))) return false;
    if (id === 'B5') {
      const rows = events.filter(event => event.event === 'upstream-request');
      return rows.length === 5 && typeof rows[0].credential === 'string' && rows[0].credential !== rows[4].credential
        && rows.slice(0, 4).every(row => row.credential === rows[0].credential && row.requested_tenant === 'tenant1')
        && rows[4].requested_tenant === 'tenant2' && typeof rows[4].credential === 'string';
    }
    const rows = evidence.native_phase.upstream_executions;
    assert.ok(Array.isArray(rows), `${id} correlated upstream executions missing`);
    assert.deepEqual(rows, evidence.workload_executions?.filter(row => row.phase === id), `${id} native/upstream journal mismatch`);
    const successes = requests.map(request => rows.filter(row => row.request_id === request.request_id && row.status === 200));
    if (!successes.every(group => group.length === 1 && typeof group[0].account === 'string' && group[0].account.length > 0)) return false;
    const s = successes.map(group => group[0]);
    if (id === 'B4') {
      const faults = rows.filter(row => row.request_id === 'B4:2' && row.status === 503 && row.account === s[0].account);
      return faults.length === 1 && rows.indexOf(faults[0]) < rows.indexOf(s[2]) && s[0].account !== s[1].account
        && s[2].account !== s[0].account && s[4].account === s[2].account && s[3].account === s[1].account && s[5].account === s[1].account;
    }
    return rows.length === 4 && s.every(row => typeof row.connection_id === 'string' && row.connection_id.length > 0)
      && s[0].account === s[1].account && s[2].account === s[3].account && s[0].account !== s[2].account
      && s[0].connection_id === s[1].connection_id && s[2].connection_id === s[3].connection_id && s[0].connection_id !== s[2].connection_id;
  }
  if (id === 'B8') {
    const upstream = events.filter(event => event.event === 'upstream-request' && !event.calibration);
    const update = one('config-update');
    const consumed = one('inflight-consumed');
    const before = requests.filter(request => request.logical_id === 'b8-req-1-inflight-stream');
    const after = requests.filter(request => request.logical_id === 'b8-req-2-after-switch');
    if (before.length !== 1 || after.length !== 1 || evidence.native_phase?.failure) return false;
    const oldHop = upstream.filter(event => event.request_id === before[0].logical_id);
    const newHop = upstream.filter(event => event.request_id === after[0].logical_id);
    const nextStart = events.filter(event => event.event === 'client-request' && event.request_id === after[0].request_id);
    const index = event => evidence.events.indexOf(event);
    return oldHop.length === 1 && newHop.length === 1 && nextStart.length === 1
      && consumed.logical_id === before[0].logical_id && typeof consumed.body === 'string' && consumed.body.includes('data:')
      && index(oldHop[0]) < index(consumed) && index(consumed) < index(update) && index(update) < index(nextStart[0]) && index(nextStart[0]) < index(newHop[0])
      && update.status >= 200 && update.status < 300 && /proxy-url:\s*["']?direct["']?\s*$/m.test(update.yaml)
      && oldHop[0].config_generation === 1 && typeof oldHop[0].proxy_listener === 'string'
      && newHop[0].config_generation === 2 && newHop[0].proxy_listener === null
      && requests.length === 12 && requests.every(request => request.status === 200 && request.error === null && verifyCoreBody(
        typeof request.response_body === 'string' ? Array.from(new TextEncoder().encode(request.response_body)) : request.response_body,
        { text: 'xx', input_tokens: 16, output_tokens: 2 }));
  }
  if (id === 'B3') {
    const upstream = events.filter(event => event.event === 'upstream-request' && !event.calibration);
    if (evidence.native_phase?.failure || requests.length !== 5 || upstream.length !== 5) return false;
    return new Set(upstream.map(event => event.credential)).size === 1 && typeof upstream[0].credential === 'string'
      && upstream.every((event, index) => !event.routing_headers?.session && !event.routing_headers?.client_request &&
        (index === 0 || event.body?.messages?.some(message => message.role === 'assistant' && typeof message.content === 'string' && message.content.length > 0)))
      && requests.every((request, index) => request.status === 200 && request.error === null && verifyCoreBody(request.response_body,
        { text: 'xx', input_tokens: 16 + (index + 1) * 32, output_tokens: 2 }));
  }
  if (id === 'B6') {
    assert.ok(Array.isArray(executions), 'B6 upstream executions missing');
    const refresh = one('refresh-request'), disk = one('credential-file');
    const bindings = Object.entries(evidence.phase_bindings ?? {}).filter(([logical]) => logical.startsWith('b6-burst-'));
    return requests.length === 100 && bindings.length === 100 && new Set(bindings.map(([, observation]) => observation)).size === 100
      && new Set(requests.map(request => request.logical_id)).size === 100
      && typeof refresh.response?.access_token === 'string' && refresh.response.access_token.length > 0
      && typeof refresh.response?.refresh_token === 'string' && refresh.response.refresh_token.length > 0
      && requests.every(request => request.status === 200 && request.error === null && bindings.some(([logical]) => logical === request.logical_id))
      && disk.value?.access_token === refresh.response.access_token && disk.value?.refresh_token === refresh.response.refresh_token
      && requests.every(request => {
        const successful = executions.filter(event => event.id === request.logical_id && event.status === 200);
        return successful.length === 1 && successful[0].authHeader === `Bearer ${refresh.response.access_token}`
          && successful[0].observation_id === evidence.phase_bindings[request.logical_id];
      });
  }
  if (id === 'B7') {
    assert.ok(Array.isArray(executions), 'B7 executions missing');
    const admin = one('admin-stats').value;
    const faults = requests.filter(request => request.logical_id?.startsWith('b7-postcommit-'));
    const retries = requests.filter(request => request.logical_id?.startsWith('b7-failover-'));
    const expectedIds = Array.from({ length: 10 }, (_, index) => [`b7-failover-${index}`, `b7-postcommit-${index}`]).flat();
    const bindings = Object.entries(evidence.phase_bindings ?? {}).filter(([logical]) => logical.startsWith('b7-'));
    if (requests.length !== 20 || faults.length !== 10 || retries.length !== 10 || bindings.length !== 20
      || new Set(bindings.map(([, observation]) => observation)).size !== 20
      || !expectedIds.every(logical => requests.filter(request => request.logical_id === logical).length === 1 && typeof evidence.phase_bindings[logical] === 'string' && evidence.phase_bindings[logical].length > 0)
      || !Array.isArray(admin?.accounts) || !Array.isArray(evidence.lifecycle)) return false;
    if (executions.some(event => !expectedIds.includes(event.id) || event.observation_id !== evidence.phase_bindings[event.id])) return false;
    if (!admin.accounts.some(account => account.id === 'burst' && account.health?.status === 'cooldown') || admin.accounts.some(account => account.id !== 'burst' && account.health?.status === 'cooldown')) return false;
    return Number.isInteger(admin.failed_over) && admin.failed_over > 0 && admin.failed_over <= 2 * retries.length
      && executions.some(event => event.status === 429) && retries.every(request => {
        const attempts = executions.filter(event => event.id === request.logical_id);
        return request.status === 200 && request.error === null && attempts.filter(event => event.status === 200).length === 1
          && attempts.every(event => event.status === 200 || event.status === 429)
          && attempts.at(-1)?.status === 200;
      })
      && faults.every(request => {
        const commit = events.filter(event => event.event === 'downstream-commit' && event.logical_id === request.logical_id);
        const fault = events.filter(event => event.event === 'postcommit-fault' && event.logical_id === request.logical_id);
        const drain = events.filter(event => event.event === 'postcommit-drain' && event.logical_id === request.logical_id);
        const observation = evidence.phase_bindings[request.logical_id];
        const finalized = lifecycle(evidence.lifecycle, observation, 'finalized');
        const recorded = lifecycle(evidence.lifecycle, observation, 'recorded');
        const started = evidence.lifecycle.filter(event => event.event === 'request' && event.observation_id === observation);
        return commit.length === 1 && fault.length === 1 && drain.length === 1 && drain[0].failure_observed === true
          && events.indexOf(fault[0]) < events.indexOf(drain[0])
          && started.length === 1 && finalized.length === 1 && recorded.length === 1
          && evidence.lifecycle.indexOf(started[0]) < evidence.lifecycle.indexOf(finalized[0])
          && evidence.lifecycle.indexOf(finalized[0]) < evidence.lifecycle.indexOf(recorded[0]) && commit[0].status === 200
          && commit[0].observation_id === evidence.phase_bindings?.[request.logical_id] && fault[0].observation_id === commit[0].observation_id
          && events.indexOf(commit[0]) < events.indexOf(fault[0]) && fault[0].action === 'upstream-controller-error'
          && typeof request.response_body === 'string' && request.response_body.includes('committed')
          && (request.error !== null || /"error"|response.failed|response.incomplete/.test(request.response_body))
          && executions.filter(event => event.id === request.logical_id).length === 1
          && executions.find(event => event.id === request.logical_id).status === 200;
      });
  }
  if (id === 'B11') {
    const peak = one('admission-peak');
    return requests.length === 525 && requests.filter(request => request.status === 200 && request.error === null).length === 512
      && requests.filter(request => request.status === 503 && request.error === null).length === 13
      && peak.active_in_mock === 512 && peak.in_flight === 512
      && evidence.resources.filter(resource => resource.phase === id).some(resource => Number.isFinite(resource.rss_bytes) && resource.rss_bytes >= 0 && resource.rss_bytes < 512 * 1024 * 1024);
  }
  if (id === 'B12') {
    assert.ok(Array.isArray(executions), 'B12 upstream executions missing');
    const reloads = events.filter(event => event.event === 'reload-response');
    return reloads.length === 5 && new Set(reloads.map(event => event.iteration)).size === 5 && requests.length === 5
      && reloads.every(reload => reload.status >= 200 && reload.status < 300 && Array.isArray(reload.removed_credentials)
        && requests.filter(request => request.logical_id === `b12-traffic-${reload.iteration}` && request.status === 200 && request.error === null).length === 1
        && executions.filter(event => event.id === `b12-traffic-${reload.iteration}` && event.status === 200 && event.authHeader === `Bearer ${reload.new_credential}`).length === 1
        && !executions.some(event => event.time >= reload.observed_at && reload.removed_credentials.some(token => event.authHeader === `Bearer ${token}`)));
  }
  throw new Error(`${id} producer schema adapter not yet available`);
}
