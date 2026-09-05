import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '../..');
const targets = {
  'darwin-aarch64': ['aarch64-apple-darwin', 'mahoquot_aarch64.app.tar.gz'],
  'darwin-x86_64': ['x86_64-apple-darwin', 'mahoquot_x64.app.tar.gz'],
  'windows-x86_64': ['x86_64-pc-windows-msvc', 'mahoquot_0.1.0_x64-setup.exe'],
  'linux-x86_64': ['x86_64-unknown-linux-gnu', 'mahoquot_0.1.0_amd64.AppImage'],
};
function command(bin, args) {
  const r = spawnSync(bin, args, { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr || String(r.error));
  return r;
}
test('R30 updater manifest resolves every exact target and rejects mismatched signed bundles', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mahoquot-updater-'));
  try {
    command('minisign', ['-G', '-W', '-p', join(dir, 'key.pub'), '-s', join(dir, 'key')]);
    const config = JSON.parse(readFileSync(join(root, 'crates/monitor-ui/tauri.conf.json')));
    config.plugins.updater.pubkey = Buffer.from(readFileSync(join(dir, 'key.pub'))).toString('base64');
    writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
    for (const [triple, name] of Object.values(targets)) {
      const folder = join(dir, 'artifacts', `mahoquot-${triple}`, 'bundle');
      mkdirSync(folder, { recursive: true });
      const file = join(folder, name);
      writeFileSync(file, `signed fixture ${triple}`);
      command('minisign', ['-S', '-s', join(dir, 'key'), '-m', file]);
      writeFileSync(`${file}.sig`, Buffer.from(readFileSync(`${file}.minisig`)).toString('base64'));
    }
    const args = [join(root, 'scripts/generate-updater-manifest.mjs'), join(dir, 'artifacts'), join(dir, 'config.json'), 'v0.1.0', 'indosaram/mahoquot', join(dir, 'release')];
    command('node', args);
    const manifest = JSON.parse(readFileSync(join(dir, 'release/latest.json')));
    assert.equal(manifest.version, '0.1.0');
    assert.deepEqual(Object.keys(manifest.platforms).sort(), Object.keys(targets).sort());
    for (const [target, [triple, name]] of Object.entries(targets)) {
      const entry = manifest.platforms[target];
      assert.equal(entry.url, `https://github.com/indosaram/mahoquot/releases/download/v0.1.0/${target}-${name}`);
      const source = join(dir, 'artifacts', `mahoquot-${triple}`, 'bundle', name);
      assert.equal(entry.signature, readFileSync(`${source}.sig`, 'utf8'));
      assert.deepEqual(readFileSync(join(dir, 'release', `${target}-${name}`)), readFileSync(source));
      command('minisign', ['-V', '-p', join(dir, 'key.pub'), '-m', join(dir, 'release', `${target}-${name}`), '-x', `${source}.minisig`]);
    }
    const wrongVersion = [...args]; wrongVersion[3] = 'v0.2.0';
    assert.notEqual(spawnSync('node', wrongVersion).status, 0);
    const [triple, name] = targets['linux-x86_64'];
    const artifact = join(dir, 'artifacts', `mahoquot-${triple}`, 'bundle', name);
    writeFileSync(artifact, 'tampered payload');
    assert.notEqual(spawnSync('node', args).status, 0);
    rmSync(`${artifact}.sig`);
    assert.notEqual(spawnSync('node', args).status, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('R30 bundle configuration produces updater artifacts including Linux AppImage', () => {
  const config = JSON.parse(readFileSync(join(root, 'crates/monitor-ui/tauri.conf.json')));
  assert.equal(config.bundle.createUpdaterArtifacts, true);
  assert.ok(config.bundle.targets.includes('appimage'));
});
