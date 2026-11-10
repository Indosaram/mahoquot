import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const exec = promisify(execFile);

async function recordGate({ missingMinisign = false, mode = '--all', fail = '', disposable = '1' } = {}) {
  const fixture = await mkdtemp(join(tmpdir(), 'mahoquot-gate-docs-'));
  try {
    for (const directory of ['scripts', 'bin', 'site/node_modules', 'crates/monitor-ui/frontend/node_modules', 'crates/monitor-ui/ui', 'crates/monitor-ui/gateways', 'mahoquot-proxy/ui']) {
      await mkdir(join(fixture, directory), { recursive: true });
    }
    await copyFile(join(root, 'scripts/verify.sh'), join(fixture, 'scripts/verify.sh'));
    for (const path of ['mahoquot-proxy/Cargo.toml', 'mahoquot-proxy/ui/index.html', 'crates/monitor-ui/ui/index.html', 'crates/monitor-ui/gateways/mahoquot-gateway-fixture', 'crates/monitor-ui/gateways/mahoquot-captcha-solver-fixture']) {
      await writeFile(join(fixture, path), 'synthetic invocation fixture; not an executable or certification');
    }
    const recorder = join(fixture, 'recorder.cjs');
    await writeFile(recorder, `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const command = path.basename(process.argv[1]);
const args = process.argv.slice(2);
fs.appendFileSync(process.env.RECORD, JSON.stringify({ command, args, cwd: process.cwd(), offline: process.env.CARGO_NET_OFFLINE, noInstall: process.env.BUN_INSTALL_AUTO }) + '\\n');
if (process.env.FAIL_ENTRY && args.includes(process.env.FAIL_ENTRY)) process.exit(17);
`);
    await chmod(recorder, 0o755);
    for (const command of ['bun', 'bunx', 'node', 'python3', 'cargo', 'rustc', 'codesign', ...(missingMinisign ? [] : ['minisign'])]) {
      await symlink(recorder, join(fixture, 'bin', command));
    }
    for (const [name, source] of [['dirname', '/usr/bin/dirname'], ['uname', '/usr/bin/uname'], ['shasum', '/usr/bin/shasum'], ['awk', '/usr/bin/awk']]) {
      await symlink(source, join(fixture, 'bin', name));
    }
    const record = join(fixture, 'calls.jsonl');
    await writeFile(record, '');
    let status = 0;
    let stderr = '';
    try {
      await exec('/bin/bash', ['scripts/verify.sh', mode], {
        cwd: fixture,
        env: { PATH: join(fixture, 'bin'), HOME: fixture, RECORD: record, FAIL_ENTRY: fail, CARGO_BUILD_TARGET: 'fixture', MAHOQUOT_SKIP_GATEWAY_BUILD: '1', MAHOQUOT_VERIFY_DISPOSABLE: disposable },
        timeout: 20000,
      });
    } catch (error) {
      if (typeof error.code !== 'number') throw error;
      status = error.code;
      stderr = error.stderr;
    }
    const calls = (await readFile(record, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    // macOS resolves /var to /private/var, so the child's reported cwd does not
    // share the mkdtemp prefix. Normalize against both spellings.
    const bases = [fixture, await realpath(fixture)];
    const relative = (cwd) => {
      for (const base of bases) {
        if (cwd === base) return '/';
        if (cwd.startsWith(`${base}/`)) return cwd.slice(base.length);
      }
      return cwd;
    };
    return { status, stderr, calls: calls.map(call => ({ ...call, cwd: relative(call.cwd) })) };
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}

test('DS02 aggregate dispatches each suite once, builds before browsers, and never installs', async () => {
  const { status, calls } = await recordGate();
  assert.equal(status, 0);
  const matching = (command, predicate) => calls.filter(call => call.command === command && predicate(call));
  for (const entry of ['ci-delivery.test.mjs', 'updater-manifest.test.mjs', 'review-20261025-gate-docs.test.mjs']) {
    assert.equal(matching('node', call => call.args.includes(`scripts/tests/${entry}`)).length, 1);
  }
  assert.equal(matching('python3', call => call.args.includes('test_proxy_selection.py')).length, 1);
  assert.equal(matching('python3', call => call.args.includes('scripts/tests/review-20261025-evidence-harness.test.py')).length, 1);
  const bunTests = matching('bun', call => call.args[0] === 'test');
  assert.equal(bunTests.length, 1);
  assert.equal(new Set(bunTests[0].args).size, bunTests[0].args.length);
  for (const path of ['scripts/tests/review-20261025-qa-orchestration-repair.test.mjs', 'scripts/tests/review-20261025-qa-case-repair.test.mjs', 'scripts/tests/review-20261025-wire-contracts.test.mjs', 'scripts/tests/review-20261025-cancel-observations.test.mjs', 'scripts/tests/review-20261025-expiry-quota.test.mjs', 'scripts/tests/review-20261025-resilience-observations.test.mjs', 'scripts/tests/review-20261025-desktop-disposable-harness.test.mjs', 'scripts/tests/review-20261025-paired-contract.test.mjs', 'scripts/tests/review-20261025-discovery-pty.test.mjs', 'scripts/tests/review-20261025-interaction-extra-contract.test.mjs', 'scripts/tests/review-20261025-stat-process-ownership.test.mjs', 'scripts/tests/review-20261025-management-method-schemas.test.mjs', 'scripts/tests/review-20261025-inventory-contract.test.mjs', 'scripts/tests/review-20261025-phase-benchmark-raw.test.mjs', 'scripts/qa/cases/options.test.mjs', 'scripts/qa/cliproxy-audit.test.mjs']) {
    assert.ok(bunTests[0].args.includes(path));
  }
  assert.equal(matching('node', call => call.args.includes('site/e2e/site-unit.config.ts')).length, 1);
  const browser = matching('bunx', call => call.cwd === '/site' && call.args.includes('playwright'));
  assert.equal(browser.length, 1);
  assert.deepEqual(browser[0].args, ['--no-install', 'playwright', 'test', 'e2e/spatial.spec.ts', '--project=chromium', '--workers=1']);
  for (const cwd of ['/site', '/crates/monitor-ui/frontend']) {
    const build = calls.findIndex(call => call.cwd === cwd && call.args.join(' ') === 'run build');
    const testIndex = calls.findIndex(call => call.cwd === cwd && (call.args.includes('playwright') || call.args.includes('test:e2e')));
    assert.ok(build >= 0 && testIndex > build);
    assert.equal(calls.filter(call => call.cwd === cwd && call.args.join(' ') === 'run build').length, 1);
  }
  assert.ok(calls.every(call => !call.args.includes('install')));
  assert.ok(calls.every(call => call.offline === 'true' && call.noInstall === 'disable'));
});

test('DS02 missing prerequisites stop before any suite dispatch', async () => {
  const result = await recordGate({ missingMinisign: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /minisign/);
  assert.deepEqual(result.calls, []);
  const unsafe = await recordGate({ disposable: '' });
  assert.notEqual(unsafe.status, 0);
  assert.deepEqual(unsafe.calls, []);
});

test('DS02 script mode avoids production builds and propagates updater failure', async () => {
  const result = await recordGate({ mode: '--scripts' });
  assert.equal(result.status, 0);
  assert.ok(result.calls.every(call => call.command !== 'cargo' && !call.args.includes('playwright') && !call.args.includes('build')));
  const failed = await recordGate({ fail: 'scripts/tests/updater-manifest.test.mjs' });
  assert.equal(failed.status, 17);
  assert.equal(failed.calls.filter(call => call.command === 'python3' || call.command === 'cargo').length, 0);
});
