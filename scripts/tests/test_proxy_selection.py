import os
from pathlib import Path
import shutil
import signal
import sys
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]


def run_fixture(args, *, timeout=60, check=False, **kwargs):
    with subprocess.Popen(args, start_new_session=True, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, text=True, **kwargs) as process:
        try:
            stdout, stderr = process.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass  # The group exited between the deadline and cleanup.
            stdout, stderr = process.communicate()
            raise AssertionError(
                f'Fixture timed out after {timeout}s: {args!r}\n'
                f'stdout:\n{stdout}\nstderr:\n{stderr}'
            ) from None
        result = subprocess.CompletedProcess(args, process.returncode, stdout, stderr)
        if check:
            result.check_returncode()
        return result


class ProxySelectionTests(unittest.TestCase):
    def test_timeout_reports_output_and_reaps_owned_process(self):
        communicate = subprocess.Popen.communicate
        owned = []

        def deadline(process, *args, **kwargs):
            if not owned:
                owned.append(process)
                # Inject the deadline; no wall-clock race is needed to exercise cleanup.
                raise subprocess.TimeoutExpired(process.args, 60)
            return communicate(process, *args, **kwargs)

        with patch.object(subprocess.Popen, 'communicate', deadline):
            with self.assertRaisesRegex(AssertionError, 'stdout:[\\s\\S]*stderr:'):
                run_fixture([sys.executable, '-c', 'import signal; signal.pause()'])
        self.assertIsNotNone(owned[0].returncode)
        with self.assertRaises(ProcessLookupError):
            os.kill(owned[0].pid, 0)

    def test_setup_and_build_select_and_stage_same_fixture(self):
        with tempfile.TemporaryDirectory(prefix='mahoquot-selection-') as temporary:
            base = Path(temporary).resolve()
            root = base / 'desktop'
            (root / 'scripts').mkdir(parents=True)
            manifest = root / 'crates/monitor-ui'
            manifest.mkdir(parents=True)
            shutil.copy2(ROOT / 'scripts/setup-gateway.sh', root / 'scripts/setup-gateway.sh')
            source = (ROOT / 'crates/monitor-ui/build.rs').read_text()
            harness = base / 'harness.rs'
            harness.write_text('use std::path::{Path, PathBuf};\nuse std::process::Command;\n' +
                               source[source.index('fn resolve_proxy_dir'):]+ '\nfn main() {\n'
                               'let root = PathBuf::from(std::env::args().nth(1).unwrap());\n'
                               'let selected = resolve_proxy_dir(&root).unwrap();\n'
                               'println!("SELECTED={}", selected.display());\n'
                               'stage_bundle_sidecar(Some(&selected));\n}\n')
            run_fixture(['rustc', '--edition=2021', str(harness), '-o', str(base / 'harness')], check=True)
            if sys.platform == 'darwin':
                run_fixture(['codesign', '--force', '--sign', '-', str(base / 'harness')], check=True)
            host = run_fixture(['rustc', '-vV'], check=True).stdout.split('host: ')[1].splitlines()[0]
            for name in ['mahoquot-proxy', 'desktop/mahoquot-proxy', 'override', 'space  proxy']:
                proxy = base / name
                (proxy / 'src').mkdir(parents=True)
                (proxy / 'Cargo.toml').write_text('[package]\nname="mahoquot-gateway"\nversion="0.1.0"\nedition="2021"\n')
                (proxy / 'src/main.rs').write_text('fn main() { println!("' + name + '"); }')
            env = {k: v for k, v in os.environ.items() if not k.startswith(('CARGO_', 'MAHOQUOT_'))}
            env.update(CARGO_BUILD_JOBS='2', CARGO_MANIFEST_DIR=str(manifest), TARGET=host, HOST=host, PROFILE='release')
            cases = [('both', None, None, 'mahoquot-proxy'),
                     ('absolute', str(base / 'override'), None, 'override'),
                     ('relative', '../override', None, 'override'),
                     ('config', None, '../override', 'override'),
                     ('config-spaces', None, '  ../space  proxy  ', 'space  proxy'),
                     ('env-over-config', '../mahoquot-proxy', '../override', 'mahoquot-proxy'),
                     ('invalid-env', '../missing', None, None),
                     ('invalid-config', None, '../missing', None),
                     ('empty-env', '', None, None),
                     ('sibling-only', None, None, 'mahoquot-proxy'),
                     ('in-repo-only', None, None, 'desktop/mahoquot-proxy')]
            for label, override, config, expected in cases:
                with self.subTest(label=label):
                    if label == 'sibling-only':
                        (root / 'mahoquot-proxy').rename(root / 'hidden-proxy')
                    elif label == 'in-repo-only':
                        (root / 'hidden-proxy').rename(root / 'mahoquot-proxy')
                        (base / 'mahoquot-proxy').rename(base / 'hidden-proxy')
                    current = dict(env)
                    if override is not None:
                        current['MAHOQUOT_PROXY_DIR'] = override
                    path_file = root / '.mahoquot-proxy-path'
                    if config is not None:
                        path_file.write_text(config + '\n')
                    else:
                        path_file.unlink(missing_ok=True)
                    sidecar = manifest / 'gateways' / ('mahoquot-gateway-' + host)
                    sidecar.unlink(missing_ok=True)
                    setup = run_fixture(['bash', str(root / 'scripts/setup-gateway.sh')], cwd=base, env=current)
                    if expected is None:
                        self.assertNotEqual(setup.returncode, 0, setup.stdout)
                    else:
                        self.assertEqual(setup.returncode, 0, setup.stderr)
                        self.assertEqual(run_fixture([str(sidecar)], check=True).stdout.strip(), expected)
                    sidecar.unlink(missing_ok=True)
                    build = run_fixture([str(base / 'harness'), str(root)], cwd=base, env=current)
                    if expected is None:
                        self.assertNotEqual(build.returncode, 0, build.stdout)
                        self.assertFalse(sidecar.exists())
                    else:
                        self.assertEqual(build.returncode, 0, build.stderr)
                        self.assertIn('SELECTED=' + str(base / expected), build.stdout)
                        self.assertEqual(run_fixture([str(sidecar)], check=True).stdout.strip(), expected)
            # Automatic build, not only a previously compiled staging fixture.
            (base / 'hidden-proxy').rename(base / 'mahoquot-proxy')
            if (base / 'mahoquot-proxy/target').exists():
                shutil.rmtree(base / 'mahoquot-proxy/target')
            (root / '.mahoquot-proxy-path').unlink(missing_ok=True)
            run_fixture([str(base / 'harness'), str(root)], env=env, check=True)
            self.assertTrue((base / 'mahoquot-proxy/target/release/mahoquot-gateway').is_file())
