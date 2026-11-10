import { test, expect } from 'bun:test';
import { bindSource, checkedSpecialComposition, deriveRouteManifest, deriveSettingsPolicy, digest, literalRoutes, nativeTableEntries, nativeSettingEntries, parseNativeSettingsOutput, pointer, sourceFunction, validateJointInventoryIdentity, validateNativeRun, validateNativeProtocols, validateObservations } from '../qa/inventory-contract.mjs';
import { readFile } from 'node:fs/promises';
import { captureInventoryResponse } from '../qa/f1-inventory.mjs';

function fixture() {
  const bytes = Buffer.from('{"retry":2}');
  const schema = { type: 'integer' };
  const route = { id: 'GET /config', source_path: 'routes.rs', method: 'GET', requestPath: '/config', status: 200, contentType: 'application/json', schema: { type: 'object', properties: { retry: schema }, additionalProperties: false } };
  const contract = { revision: 'fixture-only', sourceHash: digest('fixture'), routes: [route], settings: [{ id: 'retry', source_path: 'settings.rs', route_id: route.id, pointer: '/retry', schema }] };
  const observation = { method: 'GET', path: '/config', status: 200, content_type: 'application/json', body_id: 'config', body_sha256: digest(bytes), transport_error: null };
  const inventory = { source_revision: contract.revision, source_sha256: contract.sourceHash, routes: [{ id: route.id, source_path: route.source_path, observed: observation }], settings: [{ id: 'retry', source_path: 'settings.rs', observed: { route_id: route.id, pointer: '/retry', current_value: 2, body_sha256: digest(bytes) } }] };
  return { contract, inventory, bodies: new Map([['config', bytes]]) };
}

function protocolFixture() {
  const sdp = 'v=0\r\na=fingerprint:sha-256 fixture\r\nm=application 18850 UDP/DTLS/SCTP webrtc-datachannel\r\na=ice-ufrag:fixture\r\na=candidate:fixture 1 udp 1 127.0.0.1 18850 typ host\r\n';
  const trigger = { kind: 'proxy', message: 'inventory-subscribed-frame' };
  const paths = ['/backend-api/codex/responses', '/v1/responses', '/responses', '/v1/realtime'];
  const captures = paths.map((path, index) => {
    const frame = JSON.stringify({ type: 'inventory.echo', nonce: `00000000-0000-4000-8000-00000000000${index}` });
    return { path, url: `ws://127.0.0.1:18840${path}`, downstream_status: 101, sent_utf8: frame, received_utf8: frame,
      upstream: { kind: 'upgrade', status: 101, path: index === 3 ? '/v1/realtime' : '/backend-api/codex/responses' } };
  });
  for (const [index, offer_path] of ['/v1/live', '/live', '/v1/realtime', '/v1/realtime/calls'].entries()) {
    const callId = `inventory-00000000-0000-4000-8000-00000000000${index}`;
    const location = `/v1/realtime/calls/${callId}`;
    const path = `${index < 2 ? offer_path : '/v1/realtime/calls'}/${callId}`;
    const frame = JSON.stringify({ type: 'inventory.echo', nonce: `00000000-0000-4000-8000-00000000000${index + 4}` });
    captures.push({ path, url: `ws://127.0.0.1:18840${path}`, downstream_status: 101, sent_utf8: frame, received_utf8: frame,
      upstream: { kind: 'upgrade', status: 101, path: location }, offer_path, offer_status: 201, non_owner_status: 403, location, offer_sdp: sdp, answer_sdp: sdp,
      upstream_offer: { kind: 'offer', status: 201, path: '/v1/realtime/calls', location, offer_sdp: sdp, answer_sdp: sdp } });
  }
  return { stream_capture: { method: 'GET', path: '/v0/management/logs/stream', status: 200, content_type: 'text/event-stream', trigger,
    body_utf8: `data: ${JSON.stringify(trigger)}\n\n` }, protocols: { captures,
      worker_capture: { path: '/v1/ws', status: 101, sent_utf8: JSON.stringify({ id: 'inventory-catalog', type: 'catalog', payload: { models: [], ack: true } }), received_utf8: JSON.stringify({ id: 'inventory-catalog', type: 'catalog_ack', payload: null }) },
    } };
}

test('native protocol validator requires subscribed SSE and both duplex upgrades with owned MediaRelay negotiation', () => {
  expect(validateNativeProtocols(protocolFixture())).toBe(true);
  const mutations = [
    value => { delete value.stream_capture; },
    value => { delete value.protocols.worker_capture; },
    value => { value.protocols.worker_capture.received_utf8 = '{}'; },
    value => { value.stream_capture.body_utf8 = ': keepalive\n\n'; },
    value => { value.stream_capture.trigger.message = 'other'; },
    value => { value.protocols.captures.pop(); },
    value => { value.protocols.captures.push(value.protocols.captures[0]); },
    value => { value.protocols.captures[0].downstream_status = 426; },
    value => { delete value.protocols.captures[0].upstream; },
    value => { value.protocols.captures[0].upstream.status = 200; },
    value => { value.protocols.captures[0].received_utf8 = '{}'; },
    value => { value.protocols.captures[0].url = 'ws://example.com/v1/responses'; },
    value => { value.protocols.captures[4].offer_status = 200; },
    value => { value.protocols.captures[4].non_owner_status = 200; },
    value => { value.protocols.captures[4].upstream_offer.location = '/v1/realtime/calls/other'; },
    value => { value.protocols.captures[4].upstream.path = '/v1/realtime/calls/other'; },
    value => { value.protocols.captures[4].offer_sdp = ''; },
    value => { value.protocols.captures[4].answer_sdp = value.protocols.captures[4].answer_sdp.replace('127.0.0.1', '192.0.2.1'); },
    value => { value.protocols.captures[4].upstream_offer.offer_sdp = value.protocols.captures[4].offer_sdp.replace('18850 typ', '19000 typ'); },
    ...['NaN', 'invalid', '18850.5', ''].map(port => value => {
      value.protocols.captures[4].offer_sdp = value.protocols.captures[4].offer_sdp.replace('18850 typ', `${port} typ`);
    }),
  ];
  for (const mutate of mutations) {
    const value = protocolFixture(); mutate(value);
    expect(() => validateNativeProtocols(value)).toThrow();
  }
});

test('table observations bind method-specific bodies to source table and reject missing or altered captures', () => {
  const path = 'crates/gateway/src/management/scalar_table.rs';
  const table = '[Scalar { path: "/debug", key: "debug", read: |s| json!(s.debug), write: write, clear: None }]';
  const source = `${table}\npub const CHANNEL_KEYED: &[&str] = &[];`;
  const manifest = { source_spans: [{ symbol: 'SCALARS', start: 0, end: table.length }], routes: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH'].map(method => ({
    id: `${method} /v0/management/debug`, method, path: '/v0/management/debug', source_path: path,
    origin: method === 'HEAD' ? 'axum-get-head' : 'table', handler: `SCALARS:${method === 'HEAD' ? 'GET' : method}`,
  })) };
  const fixture = { captures: [{ path: '/v0/management/config', value: { debug: false } }], route_captures: manifest.routes.map(row => ({
    method: row.method, path: row.path, status: ['GET', 'HEAD'].includes(row.method) ? 200 : 400,
    request_body_utf8: ['GET', 'HEAD'].includes(row.method) ? '' : '!', content_type: 'application/json',
    body_utf8: row.method === 'HEAD' ? '' : JSON.stringify(row.method === 'GET' ? { debug: false } : { error: 'invalid body' }),
  })) };
  const bytes = new Map([[path, Buffer.from(source)]]);
  expect(nativeTableEntries(fixture, manifest, bytes)).toHaveLength(5);
  for (const mutate of [
    value => value.route_captures.pop(),
    value => value.route_captures.push(value.route_captures[0]),
    value => { value.route_captures[0].body_utf8 = '{"debug":true}'; },
    value => { value.route_captures[1].body_utf8 = '{}'; },
    value => { value.route_captures[2].status = 200; },
    value => { value.route_captures[2].request_body_utf8 = '{}'; },
  ]) {
    const changed = structuredClone(fixture); mutate(changed);
    expect(() => nativeTableEntries(changed, manifest, bytes)).toThrow();
  }
});

test('conditionally omitted settings remain declared rows rather than fabricated values', () => {
  const policy = [{ id: 'v0/items', pointer: '/items', disposition: 'collection', omit_when: 'Vec::is_empty' }];
  const fixture = { serialized_settings: {}, captures: ['/v0/management/config', '/v8/management/config'].map(path => ({ path, value: {}, body_utf8: '{}' })), leaf_readbacks: [] };
  expect(nativeSettingEntries(fixture, policy)[0].observed.disposition).toBe('conditionally-omitted');
  fixture.serialized_settings.items = ['present'];
  expect(() => nativeSettingEntries(fixture, policy)).toThrow();
});

test('joint inventories cannot mix native runs or certify a settings-only document', () => {
  const common = { source_revision: 'fixture', source_sha256: digest('fixture'),
    provenance: { gateway_revision: 'fixture', gateway_source_sha256: digest('fixture') },
    native_run: { source_revision: 'fixture', source_sha256: digest('fixture'), run_id: 'one', binary_sha256: digest('binary'), stdout_sha256: digest('stdout') },
  };
  const route = { ...structuredClone(common), kind: 'route' };
  const setting = { ...structuredClone(common), kind: 'setting' };
  expect(validateJointInventoryIdentity(route, setting)).toBe(true);
  expect(() => validateJointInventoryIdentity(undefined, setting)).toThrow();
  expect(() => validateJointInventoryIdentity(route, undefined)).toThrow();
  for (const field of ['run_id', 'binary_sha256', 'stdout_sha256', 'source_revision', 'source_sha256']) {
    const changed = structuredClone(setting); changed.native_run[field] = 'other';
    expect(() => validateJointInventoryIdentity(route, changed)).toThrow();
  }
});

test('native settings output rejects duplicate, missing and substituted raw captures', () => {
  const native = {
    schema: 'inventory-native-settings/v1', serialized_settings: {}, config_yaml: '{}',
    captures: ['/v0/management/config', '/v8/management/config'].map(path => ({ method: 'GET', path, status: 200, body_utf8: '{"retry":2}', value: { retry: 2 } })),
    leaf_readbacks: [{ pointer: '/retry', method: 'GET', path: '/v8/management/config/retry', status: 200, body_utf8: '2' }],
  };
  const line = `INVENTORY_NATIVE_SETTINGS_V1=${JSON.stringify(native)}`;
  expect(parseNativeSettingsOutput(line)).toEqual(native);
  expect(() => parseNativeSettingsOutput(`${line}\n${line}`)).toThrow();
  expect(() => parseNativeSettingsOutput('')).toThrow();
  for (const mutation of [
    value => { value.leaf_readbacks = []; },
    value => { value.leaf_readbacks.push({ ...value.leaf_readbacks[0] }); },
    value => { value.leaf_readbacks[0].body_utf8 = '3'; },
    value => { value.leaf_readbacks[0].path = '/v8/management/config/invented'; },
    value => { value.leaf_readbacks[0].status = 500; },
  ]) {
    const changed = structuredClone(native); mutation(changed);
    expect(() => parseNativeSettingsOutput(`INVENTORY_NATIVE_SETTINGS_V1=${JSON.stringify(changed)}`)).toThrow();
  }
  native.captures[0].value.retry = 3;
  expect(() => parseNativeSettingsOutput(`INVENTORY_NATIVE_SETTINGS_V1=${JSON.stringify(native)}`)).toThrow();
});

test('native build/run binding rejects swapped source, binary and output', () => {
  const native = {
    schema: 'inventory-native-settings/v1', run_id: '00000000-0000-4000-8000-000000000001', serialized_settings: {}, config_yaml: '{}',
    ...protocolFixture(),
    captures: ['/v0/management/config', '/v8/management/config'].map(path => ({ method: 'GET', path, status: 200, body_utf8: '{"retry":2}', value: { retry: 2 } })),
    leaf_readbacks: [{ pointer: '/retry', method: 'GET', path: '/v8/management/config/retry', status: 200, body_utf8: '2' }],
  };
  const provenance = { gateway_revision: 'fixture', gateway_source_sha256: digest('source') };
  const binary = Buffer.from('fixture-only-not-a-real-binary');
  const buildReceipt = Buffer.from(JSON.stringify({ schema: 'inventory-native-build/v1', source_revision: 'fixture', source_sha256: provenance.gateway_source_sha256, binary_sha256: digest(binary), exit_code: 0, argv: ['cargo', 'test', '-p', 'mahoquot-gateway', '--bin', 'mahoquot-gateway', '--no-run', '--locked', '--message-format=json'] }));
  const stdout = Buffer.from(`INVENTORY_NATIVE_SETTINGS_V1=${JSON.stringify(native)}`);
  const receipt = { schema: 'inventory-native-run/v1', environment: { MAHOQUOT_QA_LOOPBACK_ONLY: '1' }, source_revision: 'fixture', source_sha256: provenance.gateway_source_sha256, binary_sha256: digest(binary), build_receipt_sha256: digest(buildReceipt), stdout_sha256: digest(stdout), exit_code: 0, signal: null, run_id: native.run_id, argv: ['--exact', 'management::inventory_qa::inventory_fixture_uses_actual_config_handlers', '--nocapture'] };
  expect(validateNativeRun(receipt, provenance, { stdout, binary, buildReceipt })).toEqual(native);
  for (const mutation of [{ environment: {} }, { exit_code: 1 }, { signal: 'SIGKILL' }, { source_revision: 'old' }, { binary_sha256: digest('other') }, { stdout_sha256: digest('other') }, { argv: [] }, { run_id: 'other' }]) {
    expect(() => validateNativeRun({ ...receipt, ...mutation }, provenance, { stdout, binary, buildReceipt })).toThrow();
  }
});

test('source spans ignore comments and strings containing delimiters', () => {
  const text = 'pub fn create_app() -> Router { /* } */ Router::new().route("/x", get(handler)) }';
  const span = sourceFunction(text, 'create_app');
  expect(span.sha256).toBe(digest(text.slice(span.start, span.end)));
  expect(() => deriveRouteManifest(new Map([['crates/gateway/src/routes.rs', Buffer.from(text)]]))).toThrow();
  expect(() => deriveRouteManifest(new Map([['crates/gateway/src/routes.rs', Buffer.from(text.replace('get(handler)', 'any(handler)'))]]))).toThrow();
  expect(() => deriveRouteManifest(new Map([['crates/gateway/src/routes.rs', Buffer.from(text.replace('Router::new()', 'Router::new().merge(unknown())'))]]))).toThrow();
});

test('actual root and OAuth composition reject additional control flow and unmounted routers', async () => {
  for (const [file, symbol] of [['routes.rs', 'create_app'], ['management/oauth.rs', 'oauth_routes']]) {
    const source = await readFile(new URL(`../../mahoquot-proxy/crates/gateway/src/${file}`, import.meta.url), 'utf8');
    const body = sourceFunction(source, symbol).text;
    expect(() => checkedSpecialComposition(body, symbol)).not.toThrow();
    expect(() => checkedSpecialComposition(body.replace('{', '{ let unused = Router::new();'), symbol)).toThrow();
    expect(() => checkedSpecialComposition(body.replace('Router::new()', 'Router::new().merge(invented())'), symbol)).toThrow();
  }
});

test('settings source policy derives renamed, optional, dynamic and nonserialized fields', () => {
  const source = `pub struct Settings {
    #[serde(rename = "proxy-url", default)] pub proxy_url: String,
    #[serde(default, skip_serializing)] pub home: Other,
    #[serde(default, skip_serializing_if = "Option::is_none")] pub enabled: Option<bool>,
    #[serde(default)] pub routing: Routing,
    #[serde(flatten)] pub extra: serde_yaml::Mapping,
  }
  pub struct Routing { #[serde(default)] pub retry: i64, }`;
  const rows = deriveSettingsPolicy(new Map([['crates/gateway/src/management/settings.rs', Buffer.from(source)]]));
  expect(rows.map(row => row.id)).toEqual(['v0/proxy-url', 'v0/home', 'v0/enabled', 'v0/routing', 'v0/routing/retry', 'v0/*']);
  expect(rows.find(row => row.id === 'v0/home').disposition).toBe('not-serialized');
  expect(rows.find(row => row.id === 'v0/enabled').omit_when).toBe('Option::is_none');
  expect(() => deriveSettingsPolicy(new Map([['crates/gateway/src/management/settings.rs', Buffer.from(source.replace('rename = "proxy-url"', 'serialize_with = "custom"'))]]))).toThrow();
});

test('literal parser preserves chained route methods and rejects unknown composition', () => {
  expect(literalRoutes('.route("/config", get(read).put(write).patch(write),)', '/v8').map(row => row.id)).toEqual(['GET /v8/config', 'PUT /v8/config', 'PATCH /v8/config']);
  for (const input of ['.route(path, method)', '.merge(other())', '.route("/x", any(handler))', '.route("/x", get(handler)).route("/x", get(handler))', '.route("/x", get(handler)) junk']) {
    expect(() => literalRoutes(input)).toThrow();
  }
});

test('source binding recomputes closure and rejects changed/extra/missing bytes', () => {
  const bytes = Buffer.from('source');
  const file = { path: 'src/routes.rs', sha256: digest(bytes) };
  const identity = { revision: 'fixture', sourceHash: digest(`${file.path}\0${file.sha256}`), files: [file] };
  expect(bindSource(identity, new Map([[file.path, bytes]])).sourceHash).toBe(identity.sourceHash);
  for (const map of [new Map(), new Map([[file.path, Buffer.from('changed')]]), new Map([[file.path, bytes], ['extra', bytes]])]) expect(() => bindSource(identity, map)).toThrow();
  expect(() => bindSource({ ...identity, files: [file, file] }, new Map([[file.path, bytes]]))).toThrow();
});

test('fixture-only positive raw readback and request capture', async () => {
  const f = fixture();
  expect(validateObservations(f.inventory, f.contract, f.bodies)).toBe(true);
  const capture = await captureInventoryResponse({ method: 'GET', path: '/config', bodyId: 'config' }, async () => new Response(f.bodies.get('config'), { headers: { 'content-type': 'application/json' } }));
  f.inventory.routes[0].observed = capture.observed;
  expect(capture.bytes.equals(f.bodies.get('config'))).toBe(true);
  expect(validateObservations(f.inventory, f.contract, f.bodies)).toBe(true);
  const failed = await captureInventoryResponse({ method: 'GET', path: '/config', bodyId: 'config' }, async () => { throw new Error('ECONNREFUSED'); });
  expect(failed.observed.status).toBeNull();
  expect(failed.bytes).toBeNull();
  f.inventory.routes[0].observed = failed.observed;
  expect(() => validateObservations(f.inventory, f.contract, f.bodies)).toThrow();
});

test('adversarial inventory mutations cannot satisfy raw contract', () => {
  const mutations = [
    f => { f.inventory.routes = []; },
    f => { f.inventory.routes.push(structuredClone(f.inventory.routes[0])); },
    f => { f.inventory.routes[0].id = 'GET /invented'; },
    f => { f.inventory.settings = []; },
    f => { f.inventory.settings.push(structuredClone(f.inventory.settings[0])); },
    f => { f.inventory.settings[0].id = 'invented'; },
    f => { f.inventory.source_revision = 'old'; },
    f => { f.inventory.source_sha256 = digest('other'); },
    f => { f.inventory.routes[0].observed.status = 500; },
    f => { f.inventory.routes[0].observed.transport_error = 'timeout'; },
    f => { f.inventory.routes[0].observed.method = 'POST'; },
    f => { f.inventory.routes[0].observed.path = '/other'; },
    f => { f.inventory.routes[0].observed.content_type = 'text/html'; },
    f => { f.inventory.routes[0].source_path = 'invented.rs'; },
    f => { f.inventory.settings[0].observed.current_value = 3; },
    f => { f.inventory.settings[0].observed.pointer = '/other'; },
    f => { f.inventory.settings[0].observed.body_sha256 = digest('other'); },
    f => { f.bodies.set('config', Buffer.from('{"retry":3}')); },
    f => { const bytes = Buffer.from('{"error":"nope"}'); f.bodies.set('config', bytes); f.inventory.routes[0].observed.body_sha256 = digest(bytes); },
    f => { f.bodies.set('extra', Buffer.from('{}')); },
    f => { f.inventory.synthetic = true; },
  ];
  for (const mutate of mutations) {
    const f = fixture();
    mutate(f);
    expect(() => validateObservations(f.inventory, f.contract, f.bodies)).toThrow();
  }
});

test('JSON pointer preserves slash and tilde keys, missing leaves fail', () => {
  expect(pointer({ 'a/b': { '~key': null } }, '/a~1b/~0key')).toBeNull();
  expect(() => pointer({}, '/missing')).toThrow();
  expect(() => pointer({}, '/~2')).toThrow();
});
