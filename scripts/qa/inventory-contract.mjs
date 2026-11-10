import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

const fail = message => { throw new Error(`inventory contract: ${message}`); };
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const methods = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace']);

// Bounded literal grammar, NOT a general Rust parser. Unknown compositions
// must fail rather than silently dropping chained methods or dynamic routes.
export function literalRoutes(expression, prefix = '') {
  const rows = [];
  let rest = expression.trim();
  while (rest) {
    const call = rest.match(/^\.route\(\s*("(?:[^"\\]|\\.)*")\s*,\s*/);
    if (!call) fail(`unknown route composition: ${rest.slice(0, 80)}`);
    const path = JSON.parse(call[1]);
    if (!path.startsWith('/') || /[?#\s]/.test(path)) fail('invalid route path');
    rest = rest.slice(call[0].length);
    let first = true;
    while (true) {
      const method = rest.match(first
        ? /^(?:axum::routing::)?([a-z]+)\(\s*([A-Za-z_][A-Za-z_0-9:]*)\s*\)/
        : /^\.([a-z]+)\(\s*([A-Za-z_][A-Za-z_0-9:]*)\s*\)/);
      if (!method || !methods.has(method[1])) fail(`unknown method expression: ${rest.slice(0, 80)}`);
      rows.push({ id: `${method[1].toUpperCase()} ${prefix}${path}`, method: method[1].toUpperCase(), path: prefix + path, handler: method[2] });
      rest = rest.slice(method[0].length).trimStart();
      first = false;
      if (!rest.startsWith('.')) break;
    }
    const end = rest.match(/^,?\s*\)/);
    if (!end) fail('unconsumed route expression');
    rest = rest.slice(end[0].length).trimStart();
  }
  exactIds(rows, rows.map(row => row.id), 'route derivation');
  return rows;
}

// Source slicing retains exact UTF-16 offsets plus byte hashes. The scanner only
// recognizes Rust delimiters, strings and comments; it never evaluates Rust.
function maskedRust(text) {
  let result = '', i = 0;
  while (i < text.length) {
    const start = i;
    if (text.startsWith('//', i)) {
      i = text.indexOf('\n', i); if (i < 0) i = text.length;
    } else if (text.startsWith('/*', i)) {
      i += 2; let depth = 1;
      while (i < text.length && depth) {
        if (text.startsWith('/*', i)) { depth++; i += 2; }
        else if (text.startsWith('*/', i)) { depth--; i += 2; }
        else i++;
      }
      if (depth) fail('unterminated source comment');
    } else {
      const character = text.slice(i).match(/^'(?:\\(?:u\{[a-fA-F0-9_]+\}|x[a-fA-F0-9]{2}|[^\r\n])|[^'\\\r\n])'/u);
      const raw = text.slice(i).match(/^r(#+)?"/);
      if (character) {
        i += character[0].length;
      } else if (raw) {
        const ending = `"${raw[1] ?? ''}`;
        const end = text.indexOf(ending, i + raw[0].length);
        if (end < 0) fail('unterminated raw string');
        i = end + ending.length;
      } else if (text[i] === '"') {
        i++;
        while (i < text.length && text[i] !== '"') { if (text[i] === '\\') i++; i++; }
        if (i === text.length) fail('unterminated string');
        i++;
      } else { result += text[i++]; continue; }
    }
    result += text.slice(start, i).replace(/[^\n]/g, ' ');
  }
  return result;
}

function closing(mask, start) {
  const pairs = { '(': ')', '[': ']', '{': '}' };
  const stack = [pairs[mask[start]]];
  if (!stack[0]) fail('invalid delimiter');
  for (let i = start + 1; i < mask.length; i++) {
    if (pairs[mask[i]]) stack.push(pairs[mask[i]]);
    else if (')]}'.includes(mask[i])) {
      if (stack.pop() !== mask[i]) fail('unbalanced source');
      if (!stack.length) return i;
    }
  }
  fail('unterminated source');
}

export function sourceFunction(source, name) {
  const mask = maskedRust(source);
  const matches = [...mask.matchAll(new RegExp(`\\bfn\\s+${name}\\s*\\(`, 'g'))];
  if (matches.length !== 1) fail(`ambiguous/missing function ${name}`);
  const args = mask.indexOf('(', matches[0].index);
  const start = mask.indexOf('{', closing(mask, args) + 1);
  const end = closing(mask, start) + 1;
  return { start, end, text: source.slice(start, end), sha256: digest(source.slice(start, end)) };
}

function callsIn(source, method) {
  const mask = maskedRust(source), rows = [];
  for (const match of mask.matchAll(new RegExp(`\\.${method}\\s*\\(`, 'g'))) {
    const open = mask.indexOf('(', match.index), end = closing(mask, open) + 1;
    rows.push({ start: match.index, end, text: source.slice(match.index, end), args: source.slice(open + 1, end - 1) });
  }
  return rows;
}

function splitArguments(text) {
  const mask = maskedRust(text), pieces = []; let start = 0;
  for (let i = 0; i < mask.length; i++) {
    if ('([{'.includes(mask[i])) i = closing(mask, i);
    else if (mask[i] === ',') { pieces.push(text.slice(start, i).trim()); start = i + 1; }
  }
  if (text.slice(start).trim()) pieces.push(text.slice(start).trim());
  return pieces;
}

function routeMethods(expression) {
  const result = []; let rest = expression.trim();
  while (rest) {
    const match = rest.match(/^(?:axum::routing::|\.)?([a-z]+)\s*\(/);
    if (!match || !methods.has(match[1])) fail(`unknown method builder: ${rest.slice(0, 60)}`);
    const open = rest.indexOf('('), end = closing(maskedRust(rest), open);
    result.push({ method: match[1].toUpperCase(), handler: rest.slice(open + 1, end).trim().replace(/,$/, '').trim() });
    rest = rest.slice(end + 1).trim();
  }
  return result;
}

// Remove comments, retaining string literals. Used for checked adapter syntax:
// whitespace is insignificant outside literals, never inside a path or key.
function canonicalRust(text) {
  let output = '', i = 0;
  while (i < text.length) {
    if (text.startsWith('//', i)) { const end = text.indexOf('\n', i); i = end < 0 ? text.length : end; continue; }
    if (text.startsWith('/*', i)) {
      let depth = 1; i += 2;
      while (i < text.length && depth) {
        if (text.startsWith('/*', i)) { depth++; i += 2; }
        else if (text.startsWith('*/', i)) { depth--; i += 2; }
        else i++;
      }
      if (depth) fail('unterminated adapter comment');
      continue;
    }
    if (text[i] === '"') {
      const start = i++;
      while (i < text.length && text[i] !== '"') { if (text[i] === '\\') i++; i++; }
      if (i === text.length) fail('unterminated adapter string');
      output += text.slice(start, ++i); continue;
    }
    if (!/\s/.test(text[i])) output += text[i];
    i++;
  }
  return output;
}

function builderChain(text, start, allowed) {
  const mask = maskedRust(text), calls = [];
  let cursor = start;
  const skip = () => { while (cursor < mask.length && /\s/.test(mask[cursor])) cursor++; };
  skip();
  const constructor = /^(?:axum::)?Router::new\(\)/.exec(mask.slice(cursor));
  if (!constructor) fail('unknown router constructor');
  cursor += constructor[0].length;
  while (true) {
    skip();
    const method = /^\.([a-z_]+)\s*\(/.exec(mask.slice(cursor));
    if (!method) break;
    if (!allowed.includes(method[1])) fail(`unknown router operation ${method[1]}`);
    const open = mask.indexOf('(', cursor), end = closing(mask, open) + 1;
    calls.push({ method: method[1], text: text.slice(cursor, end), args: text.slice(open + 1, end - 1) });
    cursor = end;
  }
  return { end: cursor, calls };
}

export function checkedSpecialComposition(text, name) {
  if (name === 'create_app') {
    const start = /^\{\s*let\s+authed_routes\s*=/.exec(maskedRust(text));
    if (!start) fail('root must declare exactly one authed router');
    const authed = builderChain(text, start[0].length, ['route', 'layer']);
    let cursor = authed.end;
    if (text[cursor] !== ';') fail('root auth router must end before public router');
    const publicRouter = builderChain(text, cursor + 1, ['route', 'nest', 'merge', 'layer', 'with_state']);
    if (maskedRust(text.slice(publicRouter.end)).trim() !== '}') fail('root contains an unreturned/extra router expression');
    const structural = publicRouter.calls.filter(call => call.method !== 'route').map(call => canonicalRust(call.text));
    const required = [
      '.nest("/v0/management",crate::management::management_router(Arc::clone(&state)),)',
      '.merge(crate::management::store::routes::v8_management_router(Arc::clone(&state),))',
      '.merge(authed_routes)', '.layer(DefaultBodyLimit::max(MAX_REQUEST_BODY_BYTES))',
      '.layer(from_fn(cors))', '.with_state(state)',
    ];
    if (!isDeepStrictEqual(structural, required)) fail('changed root mount/auth/CORS composition');
    const authLayers = authed.calls.filter(call => call.method === 'layer').map(call => canonicalRust(call.text));
    if (!isDeepStrictEqual(authLayers, [
      '.layer(Extension(Arc::new(std::sync::Mutex::new(crate::interactions::InteractionsStore::default(),))))',
      '.layer(from_fn_with_state(Arc::clone(&state),inference_admission))',
      '.layer(from_fn_with_state(Arc::new(crate::inbound::ApiKeys::with_live_settings(Arc::clone(&state.settings),(*state.api_keys).clone(),)),require_api_key,))',
      '.layer(Extension(Arc::clone(&state.realtime)))',
    ])) fail('changed authenticated router layers');
  }
  if (name === 'oauth_routes') {
    const start = /^\{\s*let\s+mut\s+router\s*=/.exec(maskedRust(text));
    if (!start) fail('unknown OAuth router declaration');
    const router = builderChain(text, start[0].length, ['route']);
    const tail = `;
      for (provider, endpoint, device) in PROVIDERS {
        router = router.route(
          Box::leak(format!("/{provider}-auth-url").into_boxed_str()),
          get(move |Query(params): Query<HashMap<String, String>>| async move {
            auth_url_for(provider, endpoint, *device, &params)
          },),
        );
      }
      router
    }`;
    if (canonicalRust(text.slice(router.end)) !== canonicalRust(tail)) fail('changed OAuth dynamic registration adapter');
  }
}

const SCALAR_ADAPTER = `{
    let mut router = Router::new();
    for scalar in SCALARS {
        let path = scalar.path;
        let mut method = get(move |State(state): State<Arc<AppState>>| async move {
            read_scalar(state, find(path).expect("registered")).await
        })
        .post(move |State(state): State<Arc<AppState>>, body: bytes::Bytes| async move {
            write_scalar(state, find(path).expect("registered"), body).await
        },)
        .put(move |State(state): State<Arc<AppState>>, body: bytes::Bytes| async move {
            write_scalar(state, find(path).expect("registered"), body).await
        },)
        .patch(move |State(state): State<Arc<AppState>>, body: bytes::Bytes| async move {
            let scalar = find(path).expect("registered");
            if super::scalar_table::is_channel_keyed(scalar.path) { return patch_channel(body); }
            write_scalar(state, scalar, body).await
        },);
        if scalar.clear.is_some() {
            method = method.delete(move |State(state): State<Arc<AppState>>, Query(params): Query<HashMap<String, String>>| async move {
                clear_scalar(state, find(path).expect("registered"), params).await
            },);
        }
        router = router.route(path, method);
    }
    router
}`;
const KEY_ADAPTER = `{
    let mut router = Router::new()
        .route("/api-key-usage", get(api_key_usage))
        .route("/usage-queue", get(usage_queue));
    for list in KEY_LISTS {
        let path = list.path;
        router = router.route(path,
            get(move |State(state): State<Arc<AppState>>| async move { read(state, entry(path)).await })
            .post(move |State(state): State<Arc<AppState>>, body: bytes::Bytes| async move { replace(state, entry(path), body).await },)
            .put(move |State(state): State<Arc<AppState>>, body: bytes::Bytes| async move { replace(state, entry(path), body).await },)
            .patch(move |State(state): State<Arc<AppState>>, body: bytes::Bytes| async move { edit(state, entry(path), body).await },)
            .delete(move |State(state): State<Arc<AppState>>, Query(params): Query<HashMap<String, String>>| async move { remove(state, entry(path), params).await },),
        );
    }
    router
}`;

const GATEWAY = 'crates/gateway/src/';
const MANAGEMENT = `${GATEWAY}management/`;
const GROUPS = {
  accounts: 'account_management_routes', apikeys: 'apikeys_routes', creds: 'creds_routes',
  history: 'history_routes', observability: 'observability_routes', plugins: 'plugins_routes',
  omo_profile: 'omo_profile_routes', registry: 'registry_routes', core: 'core_routes',
  scoped_keys: 'scoped_keys_routes', scalars: 'scalars_routes', scheduler: 'scheduler_routes', warmup: 'warmup_routes',
};

// This is an explicit composition graph, not a caller-supplied coverage list.
// Every route/merge/nest call in every reachable function must be consumed.
export function deriveRouteManifest(sourceBytes) {
  const routes = [], spans = [], visited = new Set();
  const source = path => {
    const bytes = sourceBytes.get(path);
    if (!Buffer.isBuffer(bytes)) fail(`missing source ${path}`);
    const text = bytes.toString('utf8');
    if (!Buffer.from(text).equals(bytes)) fail('source UTF-8 mismatch');
    return text;
  };
  const add = (path, method, handler, file, span, origin = 'explicit') => {
    routes.push({ id: `${method} ${path}`, method, path, handler, source_path: file, source_span: span, origin });
  };
  const walk = (file, name, prefix) => {
    const key = `${file}:${name}:${prefix}`;
    if (visited.has(key)) fail(`duplicate router mount ${key}`);
    visited.add(key);
    const full = source(file), fn = sourceFunction(full, name);
    if (name === 'create_app' || name === 'oauth_routes') checkedSpecialComposition(fn.text, name);
    // Literal registrations must be in an unconditional returned builder chain.
    // Remove complete builder arguments before checking the enclosing control
    // flow: closures may legitimately contain if/match/loops.
    if (!['scalars_routes', 'apikeys_routes', 'oauth_routes'].includes(name)) {
      let skeleton = maskedRust(fn.text);
      const removals = [];
      for (const match of skeleton.matchAll(/\.[A-Za-z_][A-Za-z_0-9]*\s*\(/g)) {
        const open = skeleton.indexOf('(', match.index);
        removals.push([open + 1, closing(skeleton, open)]);
      }
      for (const [start, end] of removals.sort((a, b) => b[0] - a[0])) {
        skeleton = skeleton.slice(0, start) + ' '.repeat(end - start) + skeleton.slice(end);
      }
      if (/\b(?:if|match|for|while|loop|return)\b|#\s*\[/.test(skeleton)) fail(`conditional/unknown router composition ${name}`);
      const variables = [...skeleton.matchAll(/\blet\s+(?:mut\s+)?([a-z_]+)\s*=/g)].map(match => match[1]);
      if (variables.length && !(name === 'create_app' && isDeepStrictEqual(variables, ['authed_routes']))) fail(`unreviewed router variable ${name}`);
    }
    if (!['scalars_routes', 'apikeys_routes', 'oauth_routes', 'create_app'].includes(name)) {
      // After replacing each complete call's arguments, only one returned
      // Router::new builder chain (and reviewed local imports) may remain.
      const mask = maskedRust(fn.text);
      let position = 1;
      while (/\s/.test(mask[position] ?? '')) position++;
      while (mask.slice(position).startsWith('use ')) {
        const semicolon = mask.indexOf(';', position);
        if (semicolon < 0) fail('unterminated router import');
        position = semicolon + 1;
        while (/\s/.test(mask[position] ?? '')) position++;
      }
      const constructor = /^(?:axum::)?Router::new\(\)/.exec(mask.slice(position));
      if (!constructor) fail(`unreviewed router constructor ${name}`);
      position += constructor[0].length;
      while (true) {
        while (/\s/.test(mask[position] ?? '')) position++;
        const call = /^\.([A-Za-z_][A-Za-z_0-9]*)\s*\(/.exec(mask.slice(position));
        if (!call) break;
        if (!['route', 'merge', 'nest', 'layer', 'fallback', 'with_state'].includes(call[1])) fail(`unknown router builder ${call[1]}`);
        position = closing(mask, mask.indexOf('(', position)) + 1;
      }
      if (mask.slice(position).trim() !== '}') fail(`unreturned/extra router expression ${name}`);
    }
    spans.push({ source_path: file, symbol: name, start: fn.start, end: fn.end, sha256: fn.sha256 });
    const spanOf = call => ({ start: fn.start + call.start, end: fn.start + call.end, sha256: digest(call.text) });
    for (const call of callsIn(fn.text, 'route')) {
      const args = splitArguments(call.args);
      if (args.length !== 2) fail('unknown route arity');
      if (!args[0].startsWith('"')) {
        if (!['scalars_routes', 'apikeys_routes', 'oauth_routes'].includes(name)) fail(`unknown dynamic route in ${name}`);
        continue;
      }
      let path; try { path = JSON.parse(args[0]); } catch { fail('nonliteral path'); }
      for (const entry of routeMethods(args[1])) add(prefix + path, entry.method, entry.handler, file, spanOf(call));
    }
    const mergeTargets = new Map(Object.entries(GROUPS).map(([group, symbol]) => [`${group}::${symbol}()`, [`${MANAGEMENT}${group}.rs`, symbol, prefix]]));
    mergeTargets.set('crate::compat::meta::onboarding_routes()', [`${GATEWAY}compat/meta.rs`, 'onboarding_routes', prefix]);
    mergeTargets.set('super::oauth::oauth_routes()', [`${MANAGEMENT}oauth.rs`, 'oauth_routes', prefix]);
    mergeTargets.set('super::store::quotas::routes()', [`${MANAGEMENT}quotas.rs`, 'routes', prefix]);
    mergeTargets.set('super::v8::routes()', [`${MANAGEMENT}v8/mod.rs`, 'routes', '/v8/management']);
    mergeTargets.set('crate::management::store::routes::v8_management_router(Arc::clone(&state),)', [`${MANAGEMENT}routes.rs`, 'v8_management_router', '']);
    for (const call of callsIn(fn.text, 'merge')) {
      const expression = call.args.replace(/\s/g, '');
      if (name === 'create_app' && expression === 'authed_routes') continue; // same function's literal routes consumed above
      const target = mergeTargets.get(expression);
      if (!target) fail(`unknown merge ${expression}`);
      walk(...target);
    }
    for (const call of callsIn(fn.text, 'nest')) {
      const expression = call.args.replace(/\s/g, '');
      if (name === 'create_app' && expression === '"/v0/management",crate::management::management_router(Arc::clone(&state)),') walk(`${MANAGEMENT}mod.rs`, 'management_router', '/v0/management');
      else if (name === 'v8_management_router' && expression === '"/v8/management",v8_config_routes().merge(super::v8::routes()),') walk(`${MANAGEMENT}routes.rs`, 'v8_config_routes', '/v8/management');
      else fail(`unknown nest ${expression}`);
    }
    if (name === 'scalars_routes' || name === 'apikeys_routes') {
      const scalar = name === 'scalars_routes';
      const tableFile = scalar ? `${MANAGEMENT}scalar_table.rs` : file;
      const tableName = scalar ? 'SCALARS' : 'KEY_LISTS';
      const text = source(tableFile), mask = maskedRust(text);
      const declaration = new RegExp(`(?:pub\\s+)?(?:const|static)\\s+${tableName}\\s*:[^=]+=`).exec(mask);
      if (!declaration) fail(`missing ${tableName}`);
      const start = mask.indexOf('[', declaration.index + declaration[0].length), end = closing(mask, start);
      const entries = splitArguments(text.slice(start + 1, end));
      spans.push({ source_path: tableFile, symbol: tableName, start, end: end + 1, sha256: digest(text.slice(start, end + 1)) });
      for (const entry of entries) {
        const type = scalar ? 'Scalar' : 'KeyList';
        if (!new RegExp(`^${type}\\s*\\{`).test(entry)) fail(`unknown ${tableName} entry`);
        const path = entry.match(/\bpath:\s*("[^"]+")/);
        const clear = scalar ? entry.match(/\bclear:\s*(None|Some\s*\()/) : null;
        if (!path || (scalar && !clear)) fail('unknown table shape');
        const selected = ['GET', 'POST', 'PUT', 'PATCH'];
        if (!scalar || clear[1] !== 'None') selected.push('DELETE');
        for (const method of selected) add(prefix + JSON.parse(path[1]), method, `${tableName}:${method}`, tableFile, { start, end: end + 1, sha256: digest(text.slice(start, end + 1)) }, 'table');
      }
      // Checked templates bind every branch, method and table traversal. A new
      // conditional, method or alternate table requires review, not inference.
      if (canonicalRust(fn.text) !== canonicalRust(scalar ? SCALAR_ADAPTER : KEY_ADAPTER)) fail(`changed ${tableName} registration adapter`);
    }
    if (name === 'oauth_routes') {
      if (!/const PROVIDERS:\s*&\[\(&str, &str, bool\)\]\s*=\s*&\[\];/.test(full)) fail('nonempty/unknown OAuth dynamic provider table requires reviewed adapter');
    }
    // Reject other registration APIs rather than silently omitting them.
    if (/\.(?:route_service|nest_service|fallback_service)\s*\(/.test(maskedRust(fn.text))) fail('unknown registration API');
  };
  const rootSource = source(`${GATEWAY}routes.rs`);
  if (!/pub fn create_app\(/.test(rootSource)) fail('missing application root');
  // These Rust #[path] aliases are part of the graph, not filename guesses.
  const aliases = source(`${MANAGEMENT}store.rs`);
  for (const [module, path] of [['v8_config', 'v8/config.rs'], ['v8', 'v8/mod.rs'], ['routes', 'routes.rs']]) {
    const declarations = [...aliases.matchAll(new RegExp(`#[\\s]*\\[path\\s*=\\s*"([^"]+)"\\s*\\]\\s*pub\\s+mod\\s+${module}\\s*;`, 'g'))];
    if (declarations.length !== 1 || declarations[0][1] !== path) fail(`changed module alias ${module}`);
  }
  walk(`${GATEWAY}routes.rs`, 'create_app', '');
  // Axum supplies HEAD for GET. CORS OPTIONS is middleware, not a registration;
  // record it explicitly as a policy rather than an invented route row.
  for (const route of [...routes]) if (route.method === 'GET' && !routes.some(row => row.path === route.path && row.method === 'HEAD')) routes.push({ ...route, id: `HEAD ${route.path}`, method: 'HEAD', origin: 'axum-get-head' });
  exactIds(routes, routes.map(row => row.id), 'source routes');
  return { routes, source_spans: spans, method_policy: { head: 'axum-get-head', options: 'cors-middleware-204' } };
}

export function deriveSettingsPolicy(sourceBytes) {
  const file = `${MANAGEMENT}settings.rs`;
  const bytes = sourceBytes.get(file);
  if (!Buffer.isBuffer(bytes)) fail('missing Settings source');
  const source = bytes.toString('utf8'), mask = maskedRust(source), policies = [], active = new Set();
  const escape = key => key.replace(/~/g, '~0').replace(/\//g, '~1');
  function visit(type, prefix, inherited = {}) {
    if (active.has(type)) fail(`recursive settings type ${type}`);
    const matches = [...mask.matchAll(new RegExp(`\\bpub\\s+struct\\s+${type}\\s*\\{`, 'g'))];
    if (matches.length !== 1) fail(`unknown settings type ${type}`);
    active.add(type);
    const start = mask.indexOf('{', matches[0].index), end = closing(mask, start);
    let cursor = start + 1;
    while (cursor < end) {
      // Skip whitespace/comments; attributes are interpreted separately below.
      while (/\s/.test(mask[cursor] ?? '') && cursor < end) cursor++;
      if (cursor === end) break;
      const fieldStart = cursor, attributes = [];
      while (mask.startsWith('#[', cursor)) {
        const attributeEnd = closing(mask, cursor + 1);
        attributes.push(source.slice(cursor + 2, attributeEnd));
        cursor = attributeEnd + 1;
        while (/\s/.test(mask[cursor] ?? '') && cursor < end) cursor++;
      }
      const field = /^pub\s+([a-z_][a-z_0-9]*)\s*:\s*/.exec(mask.slice(cursor));
      if (!field) fail(`unknown settings field syntax ${type}: ${source.slice(cursor, cursor + 60)}`);
      cursor += field[0].length;
      const typeStart = cursor; let angle = 0;
      while (cursor < end) {
        if (mask[cursor] === '<') angle++;
        else if (mask[cursor] === '>') angle--;
        else if (mask[cursor] === ',' && angle === 0) break;
        cursor++;
      }
      if (cursor === end || angle !== 0) fail('unknown settings type syntax');
      let fieldType = source.slice(typeStart, cursor).replace(/\s/g, '');
      cursor++;
      const serde = attributes.filter(a => a.startsWith('serde('));
      if (attributes.some(a => !a.startsWith('serde('))) fail('unknown settings field attribute');
      const options = serde.flatMap(a => splitArguments(a.slice(6, -1)));
      const optionNames = options.map(a => a.split('=')[0].trim());
      if (optionNames.some(a => !['rename', 'alias', 'default', 'skip_serializing', 'skip_serializing_if', 'flatten'].includes(a))) fail('unknown serde field policy');
      const rename = options.find(a => /^rename\s*=/.test(a));
      const key = rename ? JSON.parse(rename.slice(rename.indexOf('=') + 1)) : field[1];
      const conditional = options.find(a => /^skip_serializing_if\s*=/.test(a));
      const skip = optionNames.includes('skip_serializing');
      const flatten = optionNames.includes('flatten');
      const path = flatten ? `${prefix}/*` : `${prefix}/${escape(key)}`;
      const span = { start: fieldStart, end: cursor, sha256: digest(source.slice(fieldStart, cursor)) };
      const policy = { source_path: file, source_span: span, rust_type: fieldType, pointer: path, ...inherited };
      if (conditional) policy.omit_when = JSON.parse(conditional.slice(conditional.indexOf('=') + 1));
      if (skip) { policies.push({ ...policy, id: `v0${path}`, disposition: 'not-serialized' }); continue; }
      if (prefix === '' && key === 'remote-management') {
        policies.push({ ...policy, id: `v0${path}`, disposition: 'redacted-v0', fields: visitFieldsOnly(fieldType) });
        continue;
      }
      const optional = /^Option<(.+)>$/.exec(fieldType);
      if (optional) { fieldType = optional[1]; policy.nullable = true; }
      if (flatten || fieldType === 'serde_json::Value' || /(?:Map|BTreeMap|HashMap|Mapping)(?:<|$)/.test(fieldType)) {
        policies.push({ ...policy, id: `v0${path}`, disposition: flatten ? 'flattened-dynamic' : 'dynamic-value', expansion: 'all-captured-leaves', container_type: fieldType === 'serde_json::Value' ? 'json' : 'object' });
      } else if (/^Vec<.+>$/.test(fieldType)) {
        // A collection is one declared setting, not a fixed source index set.
        policies.push({ ...policy, id: `v0${path}`, disposition: 'collection', expansion: 'all-captured-elements', element_type: fieldType.slice(4, -1) });
      } else if (['String', 'bool', 'u16', 'u32', 'u64', 'usize', 'i32', 'i64', 'f64'].includes(fieldType)) {
        policies.push({ ...policy, id: `v0${path}`, disposition: 'leaf', value_type: fieldType === 'String' ? 'string' : fieldType === 'bool' ? 'boolean' : 'number' });
      } else {
        policies.push({ ...policy, id: `v0${path}`, disposition: 'struct-container' });
        visit(fieldType, path, { parent: `v0${path}` });
      }
    }
    active.delete(type);
  }
  function visitFieldsOnly(type) {
    const before = policies.length;
    visit(type, '/remote-management');
    return policies.splice(before).map(row => ({ pointer: row.pointer, source_span: row.source_span, rust_type: row.rust_type }));
  }
  visit('Settings', '');
  exactIds(policies, policies.map(row => row.id), 'settings source policy');
  return policies;
}

export function nativeSettingEntries(fixture, policies) {
  const v0 = fixture.captures.find(row => row.path === '/v0/management/config');
  const v8 = fixture.captures.find(row => row.path === '/v8/management/config');
  const entries = [];
  for (const policy of policies) {
    let value;
    const target = policy.disposition === 'redacted-v0' ? fixture.serialized_settings : v0.value;
    if (policy.disposition === 'not-serialized') {
      const key = policy.pointer.slice(1);
      if (Object.hasOwn(fixture.serialized_settings, key) || Object.hasOwn(v0.value, key)) fail('runtime-only setting serialized');
      entries.push({ id: policy.id, policy, observed: { disposition: 'not-serialized', body_sha256: digest(v0.body_utf8) } });
      continue;
    }
    if (policy.disposition === 'flattened-dynamic') {
      // The source-level row describes a dynamic namespace, not an arbitrary
      // promise that a caller-selected leaf list is complete.
      const parent = policy.pointer.slice(0, -2);
      value = pointer(target, parent);
      if (!object(value)) fail('flattened settings container mismatch');
    } else {
      const parentPath = policy.pointer.slice(0, policy.pointer.lastIndexOf('/'));
      const key = policy.pointer.slice(policy.pointer.lastIndexOf('/') + 1).replace(/~1/g, '/').replace(/~0/g, '~');
      const parent = pointer(target, parentPath);
      if (!Object.hasOwn(parent, key) && policy.omit_when) {
        const allowedOmissions = new Set(['Option::is_none', 'Vec::is_empty', 'String::is_empty', 'std::ops::Not::not']);
        if (!allowedOmissions.has(policy.omit_when)) fail(`unknown conditional omission ${policy.id}`);
        const serializedParent = pointer(fixture.serialized_settings, parentPath);
        if (Object.hasOwn(serializedParent, key)) fail(`captured setting omitted despite serialization ${policy.id}`);
        entries.push({ id: policy.id, policy, observed: { disposition: 'conditionally-omitted', omit_when: policy.omit_when, body_sha256: digest(v0.body_utf8) } });
        continue;
      }
      value = pointer(target, policy.pointer);
    }
    if (policy.disposition === 'redacted-v0') {
      if (Object.hasOwn(v0.value, 'remote-management')) fail('management secret section escaped redaction');
      for (const field of policy.fields) pointer(fixture.serialized_settings, field.pointer);
      entries.push({ id: policy.id, policy, observed: { disposition: 'redacted-v0', body_sha256: digest(v0.body_utf8) } });
      continue;
    }
    if (policy.disposition === 'leaf' && typeof value !== policy.value_type) fail(`setting type mismatch ${policy.id}`);
    if (policy.disposition === 'collection' && !Array.isArray(value)) fail(`collection mismatch ${policy.id}`);
    if (policy.disposition === 'struct-container' && !object(value)) fail(`struct mismatch ${policy.id}`);
    const serializedValue = pointer(fixture.serialized_settings, policy.disposition === 'flattened-dynamic' ? policy.pointer.slice(0, -2) : policy.pointer);
    if (policy.disposition === 'flattened-dynamic' && policy.pointer === '/*') {
      const redacted = { ...serializedValue }; delete redacted['remote-management'];
      if (!isDeepStrictEqual(value, redacted)) fail('flattened root serialization/readback mismatch');
    } else if (!isDeepStrictEqual(value, serializedValue)) fail(`serialized setting/readback mismatch ${policy.id}`);
    entries.push({ id: policy.id, policy, observed: { endpoint: v0.path, pointer: policy.pointer, current_value: value, body_sha256: digest(v0.body_utf8) } });
  }
  for (const readback of fixture.leaf_readbacks) {
    entries.push({ id: `v8${readback.pointer}`, source_path: `${MANAGEMENT}v8/config.rs`, observed: {
      endpoint: readback.path, pointer: readback.pointer,
      current_value: JSON.parse(readback.body_utf8), body_sha256: digest(readback.body_utf8),
      config_body_sha256: digest(v8.body_utf8),
    } });
  }
  exactIds(entries, entries.map(row => row.id), 'native setting entries');
  return entries;
}

export function validateNativeRun(receipt, provenance, { stdout, binary, buildReceipt }) {
  if (!object(receipt) || receipt.schema !== 'inventory-native-run/v1' || receipt.synthetic === true) fail('native run receipt schema');
  if (receipt.source_revision !== provenance.gateway_revision || receipt.source_sha256 !== provenance.gateway_source_sha256) fail('native run source mismatch');
  if (receipt.exit_code !== 0 || receipt.signal !== null) fail('native fixture did not exit successfully');
  const argv = ['--exact', 'management::inventory_qa::inventory_fixture_uses_actual_config_handlers', '--nocapture'];
  if (!isDeepStrictEqual(receipt.argv, argv)) fail('native fixture argv mismatch');
  for (const [name, bytes] of [['stdout', stdout], ['binary', binary], ['build_receipt', buildReceipt]]) {
    if (!Buffer.isBuffer(bytes) || digest(bytes) !== receipt[`${name}_sha256`]) fail(`native ${name} hash mismatch`);
  }
  let build;
  try { build = JSON.parse(buildReceipt.toString('utf8')); } catch { fail('invalid native build receipt'); }
  if (build.schema !== 'inventory-native-build/v1' || build.source_revision !== receipt.source_revision || build.source_sha256 !== receipt.source_sha256 || build.binary_sha256 !== receipt.binary_sha256 || build.exit_code !== 0) fail('native build binding mismatch');
  if (!isDeepStrictEqual(build.argv, ['cargo', 'test', '-p', 'mahoquot-gateway', '--bin', 'mahoquot-gateway', '--no-run', '--locked', '--message-format=json'])) fail('native build command mismatch');
  if (!isDeepStrictEqual(receipt.environment, { MAHOQUOT_QA_LOOPBACK_ONLY: '1' })) fail('native loopback environment receipt required');
  const text = stdout.toString('utf8');
  if (!Buffer.from(text).equals(stdout)) fail('native output is not UTF-8');
  const fixture = parseNativeSettingsOutput(text);
  if (fixture.run_id !== receipt.run_id || typeof receipt.run_id !== 'string' || !/^[a-f0-9-]{36}$/.test(receipt.run_id)) fail('native run id mismatch');
  validateNativeProtocols(fixture);
  return fixture;
}

export function parseNativeSettingsOutput(stdout) {
  const prefix = 'INVENTORY_NATIVE_SETTINGS_V1=';
  const lines = stdout.split(/\r?\n/).filter(line => line.startsWith(prefix));
  if (lines.length !== 1) fail('missing/duplicate native settings fixture');
  let fixture;
  try { fixture = JSON.parse(lines[0].slice(prefix.length)); } catch { fail('invalid native settings fixture'); }
  if (fixture.schema !== 'inventory-native-settings/v1' || !object(fixture.serialized_settings) || typeof fixture.config_yaml !== 'string') fail('native settings schema');
  exactIds(fixture.captures?.map(row => ({ id: `${row.method} ${row.path}` })), ['GET /v0/management/config', 'GET /v8/management/config'], 'native config captures');
  for (const row of fixture.captures) {
    if (row.status !== 200 || typeof row.body_utf8 !== 'string' || !object(row.value)) fail('native config capture failed');
    let parsed;
    try { parsed = JSON.parse(row.body_utf8); } catch { fail('native config JSON invalid'); }
    if (!isDeepStrictEqual(parsed, row.value)) fail('native config bytes/value mismatch');
  }
  const v8 = fixture.captures.find(row => row.path === '/v8/management/config').value;
  const leaves = [];
  function walk(value, path) {
    if (object(value) && Object.keys(value).length) {
      for (const [key, child] of Object.entries(value)) walk(child, `${path}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`);
    } else leaves.push(path);
  }
  walk(v8, '');
  exactIds(fixture.leaf_readbacks?.map(row => ({ id: row.pointer })), leaves, 'native leaf readbacks');
  for (const row of fixture.leaf_readbacks) {
    const components = row.pointer.slice(1).split('/').map(key => key.replace(/~1/g, '/').replace(/~0/g, '~'));
    if (components.some(key => key.includes('/'))) fail('unaddressable native leaf');
    const path = `/v8/management/config/${components.map(key => encodeURIComponent(key).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join('/')}`;
    if (row.method !== 'GET' || row.status !== 200 || row.path !== path || typeof row.body_utf8 !== 'string') fail('native leaf request mismatch');
    let value;
    try { value = JSON.parse(row.body_utf8); } catch { fail('invalid native leaf JSON'); }
    if (!isDeepStrictEqual(value, pointer(v8, row.pointer))) fail('native leaf readback mismatch');
  }
  return fixture;
}

export function validateNativeProtocols(fixture) {
  const stream = fixture.stream_capture;
  if (!object(stream) || stream.method !== 'GET' || stream.path !== '/v0/management/logs/stream' || stream.status !== 200 || stream.content_type !== 'text/event-stream' || typeof stream.body_utf8 !== 'string') fail('missing subscribed SSE capture');
  const frames = stream.body_utf8.replace(/\r\n/g, '\n').split('\n\n').filter(Boolean);
  if (frames.length !== 1) fail('SSE frame boundary mismatch');
  const lines = frames[0].split('\n');
  if (lines.some(line => !line.startsWith('data:'))) fail('SSE keepalive/unknown field is not an observation');
  let record;
  try { record = JSON.parse(lines.map(line => line.slice(5).trimStart()).join('\n')); } catch { fail('invalid subscribed SSE JSON'); }
  if (!isDeepStrictEqual(stream.trigger, { kind: 'proxy', message: 'inventory-subscribed-frame' }) || !isDeepStrictEqual(record, stream.trigger)) fail('SSE trigger/frame mismatch');
  const worker = fixture.protocols?.worker_capture;
  if (!worker || worker.path !== '/v1/ws' || worker.status !== 101) fail('missing AI Studio upgrade');
  let sentWorker, receivedWorker;
  try { sentWorker = JSON.parse(worker.sent_utf8); receivedWorker = JSON.parse(worker.received_utf8); } catch { fail('invalid AI Studio frames'); }
  if (!isDeepStrictEqual(sentWorker, { id: 'inventory-catalog', type: 'catalog', payload: { models: [], ack: true } }) || !isDeepStrictEqual(receivedWorker, { id: 'inventory-catalog', type: 'catalog_ack', payload: null })) fail('AI Studio catalogue acknowledgement mismatch');
  const captures = fixture.protocols?.captures;
  const expected = [
    '/backend-api/codex/responses', '/v1/responses', '/responses', '/v1/realtime',
    'offer:/v1/live', 'offer:/live', 'offer:/v1/realtime', 'offer:/v1/realtime/calls',
  ];
  exactIds(captures?.map(row => ({ id: row.offer_path ? `offer:${row.offer_path}` : row.path })), expected, 'native protocol captures');
  const nonces = new Set();
  const calls = new Set();
  for (const row of captures) {
    let url;
    try { url = new URL(row.url); } catch { fail('invalid native WS URL'); }
    if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || Number(url.port) < 18840 || Number(url.port) > 18899 || url.pathname !== row.path || url.search || url.hash || url.username || url.password) fail('native WS not isolated');
    if (row.downstream_status !== 101 || row.upstream?.kind !== 'upgrade' || row.upstream.status !== 101) fail('both WS upgrades required');
    if (typeof row.sent_utf8 !== 'string' || row.sent_utf8 !== row.received_utf8) fail('WS duplex frame mismatch');
    let frame;
    try { frame = JSON.parse(row.sent_utf8); } catch { fail('invalid native WS frame'); }
    if (frame.type !== 'inventory.echo' || !/^[a-f0-9-]{36}$/.test(frame.nonce) || nonces.has(frame.nonce)) fail('WS unique echo missing');
    nonces.add(frame.nonce);
    if (!row.offer_path) {
      if (row.upstream.path !== (row.path === '/v1/realtime' ? row.path : '/backend-api/codex/responses')) fail('wrong WS upstream path');
      continue;
    }
    const offer = row.upstream_offer;
    if (row.non_owner_status !== 403 || row.offer_status !== 201 || offer?.kind !== 'offer' || offer.status !== 201 || offer.path !== '/v1/realtime/calls' || offer.location !== row.location || row.upstream.path !== row.location) fail('owned call offer/upgrade binding mismatch');
    if (typeof row.location !== 'string' || !/^\/v1\/realtime\/calls\/inventory-[a-f0-9-]{36}$/.test(row.location) || calls.has(row.location)) fail('missing/duplicate owned call');
    calls.add(row.location);
    const callId = row.location.split('/').at(-1);
    const prefix = row.offer_path === '/live' ? '/live/' : row.offer_path === '/v1/live' ? '/v1/live/' : '/v1/realtime/calls/';
    if (row.path !== prefix + callId) fail('owned sideband path mismatch');
    for (const sdp of [row.offer_sdp, row.answer_sdp, offer.offer_sdp, offer.answer_sdp]) {
      if (typeof sdp !== 'string' || !sdp.startsWith('v=0\r\n') || !sdp.includes('a=fingerprint:') || !sdp.includes('m=application ') || !sdp.includes('a=ice-ufrag:')) fail('real WebRTC negotiation evidence missing');
      const candidates = sdp.split(/\r?\n/).filter(line => line.startsWith('a=candidate:'));
      if (!candidates.length || candidates.some(line => {
        const fields = line.split(' ');
        const port = Number(fields[5]);
        return (fields[4] !== '127.0.0.1' && fields[4] !== '::1') ||
          !/^\d+$/.test(fields[5] ?? '') || !Number.isInteger(port) || port < 18840 || port > 18899;
      })) fail('WebRTC candidates escape QA range');
    }
  }
  return true;
}

export function nativeProtocolEntries(fixture, manifest) {
  validateNativeProtocols(fixture);
  const entries = [];
  const add = (method, path, observed) => {
    const id = `${method} ${path}`;
    const route = manifest.routes.find(row => row.id === id);
    if (!route) fail(`native protocol not mounted: ${id}`);
    const handler = path === '/v1/ws' ? 'crate::aistudio::worker_upgrade' : path === '/v0/management/logs/stream' ? 'stream_logs'
      : method === 'POST' ? 'cp_routes::realtime_offer'
      : path.endsWith('/{call_id}') ? (path.startsWith('/v1/realtime/') ? 'cp_routes::realtime_call_get_owned' : 'cp_routes::live_sideband')
      : 'cp_routes::ws_upgrade';
    if (route.handler !== handler) fail(`native protocol handler changed: ${id}`);
    entries.push({ ...route, observed });
  };
  add('GET', fixture.stream_capture.path, fixture.stream_capture);
  add('GET', '/v1/ws', fixture.protocols.worker_capture);
  for (const capture of fixture.protocols.captures) {
    if (!capture.offer_path) add('GET', capture.path, capture);
    else {
      add('POST', capture.offer_path, capture);
      const path = capture.path.replace(/inventory-[a-f0-9-]{36}$/, '{call_id}');
      if (!entries.some(row => row.id === `GET ${path}`)) add('GET', path, capture);
    }
  }
  return entries;
}

export function validateJointInventoryIdentity(route, setting) {
  for (const [kind, inventory] of [['route', route], ['setting', setting]]) {
    if (!object(inventory) || inventory.kind !== kind || inventory.synthetic === true || !object(inventory.provenance) || !object(inventory.native_run)) fail(`missing joint ${kind} evidence`);
    if (inventory.source_revision !== inventory.provenance.gateway_revision || inventory.source_sha256 !== inventory.provenance.gateway_source_sha256) fail(`joint ${kind} provenance mismatch`);
    if (inventory.native_run.source_revision !== inventory.source_revision || inventory.native_run.source_sha256 !== inventory.source_sha256) fail(`joint ${kind} native source mismatch`);
  }
  if (route.source_revision !== setting.source_revision || route.source_sha256 !== setting.source_sha256 || !isDeepStrictEqual(route.provenance, setting.provenance) || !isDeepStrictEqual(route.native_run, setting.native_run)) fail('route/settings must share source, build and native run');
  return true;
}

export function nativeTableEntries(fixture, manifest, sourceBytes) {
  const scalarFile = `${MANAGEMENT}scalar_table.rs`;
  const keyFile = `${MANAGEMENT}apikeys.rs`;
  const required = manifest.routes.filter(row => row.origin === 'table' || row.origin === 'axum-get-head' && /^(SCALARS|KEY_LISTS):/.test(row.handler));
  exactIds(fixture.route_captures?.map(row => ({ id: `${row.method} ${row.path}` })), required.map(row => row.id), 'native table captures');
  const scalarText = sourceBytes.get(scalarFile)?.toString('utf8');
  if (!scalarText) fail('missing scalar source');
  const tableSpan = manifest.source_spans.find(row => row.symbol === 'SCALARS');
  if (!tableSpan) fail('missing scalar table span');
  const table = scalarText.slice(tableSpan.start + 1, tableSpan.end - 1);
  const entries = splitArguments(table);
  const canonicalStrategies = new Map();
  if (required.some(row => row.path === '/v0/management/routing/strategy')) {
    const normalize = sourceFunction(scalarText, 'normalize_routing_strategy');
    const arms = /^\{\s*match raw\.trim\(\)\.to_ascii_lowercase\(\)\.as_str\(\)\s*\{([\s\S]*)\}\s*\}$/.exec(normalize.text);
    if (!arms) fail('unknown routing normalization');
    for (const arm of splitArguments(arms[1])) {
      const match = /^((?:"[^"]*"\s*\|\s*)*"[^"]*")\s*=>\s*Some\("([^"]+)"\)$/.exec(arm);
      if (match) for (const alias of match[1].split('|')) canonicalStrategies.set(JSON.parse(alias.trim()), match[2]);
      else if (arm !== '_ => None') fail('unknown routing normalization arm');
    }
  }
  const channelDeclaration = /pub const CHANNEL_KEYED:\s*&\[&str\]\s*=\s*&\[([\s\S]*?)\];/.exec(scalarText);
  if (!channelDeclaration) fail('missing channel policy');
  const channels = splitArguments(channelDeclaration[1]).map(value => JSON.parse(value));
  const v0 = fixture.captures.find(row => row.path === '/v0/management/config').value;
  return required.map(route => {
    const captured = fixture.route_captures.find(row => `${row.method} ${row.path}` === route.id);
    let status = 400, body = { error: 'invalid body' }, requestBody = '!';
    const scalarPath = route.path.slice('/v0/management'.length);
    if (route.source_path === scalarFile) {
      const entry = entries.find(text => text.match(/\bpath:\s*("[^"]+")/)?.[1] === JSON.stringify(scalarPath));
      if (!entry) fail('missing native scalar contract');
      if (route.handler !== `SCALARS:${route.method === 'HEAD' ? 'GET' : route.method}`) fail('changed scalar method handler');
      if (['GET', 'HEAD'].includes(route.method)) {
        status = 200; requestBody = '';
        const key = JSON.parse(entry.match(/\bkey:\s*("[^"]+")/)?.[1] ?? 'null');
        if (!key) fail('unknown scalar response key');
        let value;
        if (scalarPath === '/routing/strategy') {
          const raw = v0.routing.strategy.trim().toLowerCase();
          value = canonicalStrategies.get(raw) ?? v0.routing.strategy.trim();
        } else value = pointer(v0, scalarPath);
        body = { [key]: value };
      } else if (route.method === 'PATCH' && channels.includes(scalarPath)) body = { error: 'invalid channel' };
      else if (route.method === 'DELETE') {
        requestBody = '';
        if (channels.includes(scalarPath)) body = { error: 'missing channel' };
        else { status = 200; body = { status: 'ok' }; }
      }
    } else {
      if (route.source_path !== keyFile || route.handler !== `KEY_LISTS:${route.method === 'HEAD' ? 'GET' : route.method}`) fail('changed key-list method handler');
      if (['GET', 'HEAD'].includes(route.method)) { status = 200; requestBody = ''; body = { [scalarPath.slice(1)]: pointer(v0, scalarPath) }; }
      if (route.method === 'DELETE') { requestBody = ''; body = { error: 'missing index or value' }; }
    }
    if (captured.status !== status || captured.request_body_utf8 !== requestBody || captured.content_type !== 'application/json' || typeof captured.body_utf8 !== 'string') fail(`native table request/status mismatch ${route.id}`);
    if (route.method === 'HEAD') {
      if (captured.body_utf8 !== '') fail('HEAD response body');
    } else {
      let value;
      try { value = JSON.parse(captured.body_utf8); } catch { fail('native table invalid JSON'); }
      if (!isDeepStrictEqual(value, body)) fail(`native table handler response mismatch ${route.id}`);
    }
    return { ...route, observed: { ...captured, body_sha256: digest(captured.body_utf8) } };
  });
}

export function exactIds(rows, required, label) {
  if (!Array.isArray(rows) || !Array.isArray(required) || !required.length) fail(`${label}: empty set`);
  const expected = new Set(required);
  if (expected.size !== required.length) fail(`${label}: duplicate required id`);
  const seen = new Set();
  for (const row of rows) {
    if (!object(row) || !expected.has(row.id)) fail(`${label}: invented id ${row?.id}`);
    if (seen.has(row.id)) fail(`${label}: duplicate id ${row.id}`);
    seen.add(row.id);
  }
  if (seen.size !== expected.size) fail(`${label}: missing ids`);
}

// Caller supplies an independently validated disk closure, not required_ids
// from evidence. Recheck bytes to detect edits after closure enumeration.
export function bindSource({ revision, sourceHash, files }, sourceBytes) {
  if (typeof revision !== 'string' || !revision.trim() || !Array.isArray(files) || !files.length) fail('missing source identity');
  const seen = new Set();
  for (const file of files) {
    if (!object(file) || typeof file.path !== 'string' || !file.path || file.path.split('/').some(part => !part || part === '.' || part === '..') || /[\\\0:]/.test(file.path)) fail('invalid source path');
    if (seen.has(file.path)) fail('duplicate source path');
    seen.add(file.path);
    const bytes = sourceBytes.get(file.path);
    if (!Buffer.isBuffer(bytes) || digest(bytes) !== file.sha256) fail(`source bytes mismatch: ${file.path}`);
  }
  if (sourceBytes.size !== seen.size) fail('source byte set mismatch');
  const sorted = [...files].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  if (digest(sorted.map(file => `${file.path}\0${file.sha256}`).join('\n')) !== sourceHash) fail('source closure mismatch');
  return { revision, sourceHash };
}

export function pointer(value, path) {
  if (path === '') return value;
  if (typeof path !== 'string' || !path.startsWith('/') || /~(?![01])/.test(path)) fail('invalid JSON pointer');
  for (const part of path.slice(1).split('/')) {
    const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) fail(`missing setting leaf: ${path}`);
    value = value[key];
  }
  return value;
}

// Small schema vocabulary; unknown forms fail closed. Never accept a schema
// from the observation itself as a route-specific source contract.
export function checkSchema(value, schema) {
  if (!object(schema)) fail('missing response schema');
  const allowed = new Set(['type', 'const', 'properties', 'items', 'additionalProperties']);
  if (Object.keys(schema).some(key => !allowed.has(key))) fail('unknown schema keyword');
  if (Object.hasOwn(schema, 'const') && !isDeepStrictEqual(value, schema.const)) fail('response constant mismatch');
  switch (schema.type) {
    case 'object':
      if (!object(value) || !object(schema.properties) || typeof schema.additionalProperties !== 'boolean') fail('object schema mismatch');
      for (const [key, child] of Object.entries(schema.properties)) {
        if (!Object.hasOwn(value, key)) fail(`missing response field: ${key}`);
        checkSchema(value[key], child);
      }
      if (!schema.additionalProperties && Object.keys(value).some(key => !Object.hasOwn(schema.properties, key))) fail('invented response field');
      break;
    case 'array':
      if (!Array.isArray(value) || !object(schema.items)) fail('array schema mismatch');
      value.forEach(item => checkSchema(item, schema.items));
      break;
    case 'null': if (value !== null) fail('null schema mismatch'); break;
    case 'number': if (typeof value !== 'number' || !Number.isFinite(value)) fail('number schema mismatch'); break;
    case 'integer': if (!Number.isSafeInteger(value)) fail('integer schema mismatch'); break;
    case 'string': case 'boolean': if (typeof value !== schema.type) fail(`${schema.type} schema mismatch`); break;
    default: fail('unsupported response schema type');
  }
}

export function validateCapture(capture, contract, rawBytes) {
  if (!object(capture) || capture.transport_error != null || capture.synthetic === true) fail('transport/synthetic observation');
  if (capture.method !== contract.method || capture.path !== contract.requestPath) fail('request identity mismatch');
  if (!Number.isInteger(contract.status) || contract.status < 200 || contract.status >= 500 || contract.status === 405) fail('unsupported expected status');
  if (capture.status !== contract.status) fail('route-specific status mismatch');
  if (!Buffer.isBuffer(rawBytes) || digest(rawBytes) !== capture.body_sha256) fail('raw response digest mismatch');
  const text = rawBytes.toString('utf8');
  if (!Buffer.from(text).equals(rawBytes)) fail('invalid response UTF-8');
  if (contract.contentType !== capture.content_type) fail('response content type mismatch');
  if (contract.contentType !== 'application/json') fail('unsupported response codec');
  let value;
  try { value = JSON.parse(text); } catch { fail('invalid response JSON'); }
  checkSchema(value, contract.schema);
  return value;
}

// Low-level observation verification does NOT establish gateway completeness.
// Certification additionally requires the source-derived native route contract.
export function validateObservations(inventory, contract, rawBodies) {
  if (!object(inventory) || inventory.synthetic === true || inventory.source_revision !== contract.revision || inventory.source_sha256 !== contract.sourceHash) fail('inventory source binding mismatch');
  exactIds(inventory.routes, contract.routes.map(row => row.id), 'routes');
  exactIds(inventory.settings, contract.settings.map(row => row.id), 'settings');
  const documents = new Map();
  const usedBodies = new Set();
  for (const route of contract.routes) {
    const row = inventory.routes.find(item => item.id === route.id);
    if (row.source_path !== route.source_path) fail('route source mismatch');
    if (usedBodies.has(row.observed?.body_id)) fail('reused raw response');
    usedBodies.add(row.observed?.body_id);
    documents.set(route.id, validateCapture(row.observed, route, rawBodies.get(row.observed?.body_id)));
  }
  if (usedBodies.size !== rawBodies.size) fail('raw response set mismatch');
  for (const setting of contract.settings) {
    const row = inventory.settings.find(item => item.id === setting.id);
    const observed = row.observed;
    if (row.source_path !== setting.source_path || !object(observed) || observed.transport_error != null || observed.route_id !== setting.route_id || observed.pointer !== setting.pointer) fail('setting readback identity mismatch');
    if (!documents.has(setting.route_id)) fail('missing config capture');
    const value = pointer(documents.get(setting.route_id), setting.pointer);
    checkSchema(value, setting.schema);
    if (!Object.hasOwn(observed, 'current_value') || !isDeepStrictEqual(value, observed.current_value)) fail('setting readback value mismatch');
    const route = inventory.routes.find(item => item.id === setting.route_id);
    if (observed.body_sha256 !== route.observed.body_sha256) fail('setting raw binding mismatch');
  }
  return true;
}
