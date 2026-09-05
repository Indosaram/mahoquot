import { readdirSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, copyFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const [artifacts, configPath, tag, repository, output] = process.argv.slice(2);
if (!output || !/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('Usage: generate-updater-manifest artifacts config vVERSION owner/repo output');
const config = JSON.parse(readFileSync(configPath, 'utf8'));
if (tag !== `v${config.version}` || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(config.version)) throw new Error('Release tag must match app version');
const targets = {
  'darwin-aarch64': ['aarch64-apple-darwin', '.app.tar.gz'],
  'darwin-x86_64': ['x86_64-apple-darwin', '.app.tar.gz'],
  'windows-x86_64': ['x86_64-pc-windows-msvc', '-setup.exe'],
  'linux-x86_64': ['x86_64-unknown-linux-gnu', '.AppImage'],
};
function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)]);
}
const temporary = mkdtempSync(join(tmpdir(), 'mahoquot-manifest-'));
try {
  writeFileSync(join(temporary, 'key.pub'), Buffer.from(config.plugins.updater.pubkey, 'base64'));
  const platforms = {};
  const copies = [];
  for (const [target, [triple, suffix]] of Object.entries(targets)) {
    const matches = files(join(artifacts, `mahoquot-${triple}`)).filter(file => file.endsWith(suffix));
    if (matches.length !== 1) throw new Error(`Expected exactly one updater artifact for ${target}, got ${matches.length}`);
    const file = matches[0];
    const signature = readFileSync(`${file}.sig`, 'utf8').trim();
    writeFileSync(join(temporary, 'signature'), Buffer.from(signature, 'base64'));
    execFileSync('minisign', ['-V', '-p', join(temporary, 'key.pub'), '-m', file, '-x', join(temporary, 'signature')], { stdio: 'pipe' });
    const name = `${target}-${basename(file)}`;
    platforms[target] = { signature, url: `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}` };
    copies.push([file, name]);
  }
  mkdirSync(output, { recursive: true });
  for (const [file, name] of copies) copyFileSync(file, join(output, name));
  writeFileSync(join(output, 'latest.json'), JSON.stringify({ version: config.version, platforms }, null, 2) + '\n');
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
