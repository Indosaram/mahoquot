import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const frontend = 'crates/monitor-ui/frontend';
function bunJson(code, env = {}) {
  return JSON.parse(execFileSync('bun', ['-e', code], {
    cwd: root, env: { ...process.env, ...env }, encoding: 'utf8',
  }));
}
function config(path, env) {
  return bunJson(`import config from './${path}/playwright.config.ts'; console.log(JSON.stringify(config));`, env);
}

test('R35 delivery CI builds artifacts before independent browser gates on every PR', () => {
  const workflow = bunJson(`console.log(JSON.stringify(Bun.YAML.parse(await Bun.file('.github/workflows/ci.yml').text())));`);
  assert.ok(Object.hasOwn(workflow.on, 'pull_request'));
  assert.equal(workflow.on.pull_request?.paths, undefined);
  const jobs = Object.values(workflow.jobs);
  const gate = (cwd, browser, artifact) => {
    const job = jobs.find(job => job.steps.some(step => step['working-directory'] === cwd && step.run === browser));
    assert.ok(job, `missing browser job for ${cwd}`);
    assert.equal(job.if, undefined);
    assert.equal(job.needs, undefined);
    const commands = job.steps.filter(step => step.run).map(step => {
      assert.equal(step['working-directory'], cwd);
      assert.equal(step.if, undefined);
      assert.notEqual(step['continue-on-error'], true);
      return step.run;
    });
    const index = command => { const i = commands.indexOf(command); assert.ok(i >= 0, `missing ${command}`); return i; };
    assert.ok(index('bun install --frozen-lockfile') < index('bun run build'));
    assert.ok(index('bunx playwright install --with-deps chromium') < index(browser));
    assert.ok(index('bun run build') < index(browser));
    if (artifact) assert.ok(index('bun run build') < index(artifact) && index(artifact) < index(browser));
    return job;
  };
  assert.notEqual(gate(frontend, 'bun run test:e2e', 'bun run test:artifact'), gate('site', 'bunx playwright test'));
});

test('R35 browser configurations isolate ports and preserve the site base path', () => {
  for (const [path, variable, port, suffix] of [
    [frontend, 'MAHOQUOT_E2E_PORT', 18847, ''],
    ['site', 'MAHOQUOT_SITE_QA_PORT', 18848, '/mahoquot/'],
  ]) {
    const value = config(path, { [variable]: String(port) });
    assert.equal(value.use.baseURL, `http://127.0.0.1:${port}${suffix}`);
    assert.equal(value.webServer.reuseExistingServer, false);
    assert.ok(value.webServer.url.startsWith(value.use.baseURL));
    if (path === 'site') {
      assert.match(value.webServer.command, /--host 127\.0\.0\.1/);
      assert.match(value.webServer.command, /--strictPort/);
      assert.match(value.webServer.command, /--port 18848/);
    }
  }
});

test('R35 desktop fixture serves exact artifact bytes on its configured QA port', async () => {
  let port = 18840;
  // Fail before starting the old server on an out-of-range port.
  assert.equal(config(frontend, { MAHOQUOT_E2E_PORT: String(port) }).use.baseURL, `http://127.0.0.1:${port}`);
  const temporary = await mkdtemp(join(tmpdir(), 'mahoquot-ci-'));
  let child;
  try {
    await mkdir(join(temporary, 'frontend'));
    await mkdir(join(temporary, 'ui'));
    const bytes = Buffer.from('<!doctype html><div data-fixture="fresh-artifact">π</div>');
    await writeFile(join(temporary, 'ui/index.html'), bytes);
    for (; port <= 18899; port++) {
    child = spawn('bun', [join(root, frontend, 'e2e/server.ts')], {
      cwd: join(temporary, 'frontend'), env: { ...process.env, MAHOQUOT_E2E_PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const ready = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('fixture readiness timed out')), 5000);
      let output = '';
      let errors = '';
      child.stderr.on('data', chunk => { errors += chunk; });
      child.stdout.on('data', chunk => {
        output += chunk;
        if (output.includes('mahoquot-e2e-ready')) { clearTimeout(timeout); resolve(true); }
      });
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('close', code => {
        clearTimeout(timeout);
        if (code === 98) resolve(false);
        else reject(new Error(`fixture exited ${code}: ${errors}`));
      });
    });
    if (ready) break;
    }
    assert.ok(port <= 18899, 'no available QA port in 18840-18899');
    for (const path of ['/', '/management.html']) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 200);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    }
    assert.equal((await fetch(`http://127.0.0.1:${port}/missing`, { signal: AbortSignal.timeout(5000) })).status, 404);
    const exited = once(child, 'close');
    child.kill();
    await exited;
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'close');
      child.kill();
      await exited;
    }
    await rm(temporary, { recursive: true, force: true });
  }
});
