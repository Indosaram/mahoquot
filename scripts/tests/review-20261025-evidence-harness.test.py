import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import urllib.error

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('oracle_diff', ROOT / 'scripts/mgmt_oracle_diff.py')
assert SPEC is not None and SPEC.loader is not None
ORACLE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ORACLE)


class HarnessTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='mahoquot harness ')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve() / 'checkout with spaces'
        self.root.mkdir()

    def run_process(self, argv, **kwargs):
        return subprocess.run(argv, text=True, capture_output=True, timeout=10, **kwargs)

    def test_synthetic_and_untrusted_receipts_cannot_certify(self):
        receipt = self.root / 'synthetic.json'
        result = self.run_process(['node', str(ROOT / 'scripts/platform-notch-qa.mjs'),
                                  '--target', 'macos', '--session', 'appkit', '--scenario',
                                  'hover-focus', '--evidence', str(receipt)])
        self.assertEqual(result.returncode, 2, result.stderr)
        fixture = json.loads(receipt.read_text())
        self.assertEqual(fixture['evidence_kind'], 'synthetic_fixture')
        self.assertFalse(fixture['native_observed'])
        self.assertNotEqual(fixture['status'], 'pass')
        variants = [fixture, {'status': 'pass', 'source_hash': '0' * 64},
                    {'status': 'pass', 'artifact_hash': '0' * 64},
                    {'status': 'pass', 'target': 'windows'},
                    {'status': 'pass', 'target': 'macos', 'capabilities': {}}, 'malformed']
        output = self.root / 'certificates'
        for value in variants:
            receipt.write_text(value if isinstance(value, str) else json.dumps(value))
            result = self.run_process(['bash', str(ROOT / 'scripts/certify-platform-parity.sh'),
                                      '--targets', 'macos', '--evidence', str(output),
                                      '--linux-x11-live-evidence', str(receipt)])
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(json.loads(result.stderr)['code'], 'native_observer_unavailable')
            self.assertFalse(output.exists())

    def wrappers(self):
        scripts = self.root / 'scripts/qa'
        (scripts / 'cases').mkdir(parents=True)
        for name in ('run-case-locked.sh', 'run-f3-locked.sh'):
            shutil.copyfile(ROOT / 'scripts/qa' / name, scripts / name)
        (scripts / 'cases/proxy.mjs').write_text('fixture source')
        (scripts / 'cases/desktop-parity.mjs').write_text('never executed')
        (scripts / 'cliproxy-parity.mjs').write_text('current fixture identity')
        evidence = self.root / '.omo/evidence/cliproxy-remediation/owned-run'
        evidence.mkdir(parents=True)
        bin_dir = self.root / 'bin'
        bin_dir.mkdir()
        recorder = self.root / 'invocation.json'
        bun = bin_dir / 'bun'
        bun.write_text('#!' + sys.executable + '\nimport json, os, pathlib, sys\n'
                       'pathlib.Path(os.environ["RECORDER"]).write_text(json.dumps({'
                       '"cwd": os.getcwd(), "args": sys.argv[1:], '
                       '"source": pathlib.Path(sys.argv[1]).read_text()}))\n'
                       'sys.exit(int(os.environ.get("RECORDER_EXIT", "0")))\n')
        bun.chmod(0o700)
        env = dict(os.environ, PATH=str(bin_dir) + os.pathsep + os.environ['PATH'],
                   MAHOQUOT_QA_EVIDENCE_ROOT=str(evidence), RECORDER=str(recorder))
        env.pop('MAHOQUOT_QA_LOCK_ROOT', None)
        return scripts, evidence, recorder, env

    def test_wrappers_use_current_checkout_and_clean_owned_lock(self):
        scripts, evidence, recorder, env = self.wrappers()
        for wrapper, destination in [('run-case-locked.sh', '7'), ('run-f3-locked.sh', 'f3/new.json')]:
            result = self.run_process(['bash', str(scripts / wrapper), 'proxy', 'happy', destination], env=env)
            self.assertEqual(result.returncode, 0, result.stderr)
            recorded = json.loads(recorder.read_text())
            self.assertEqual(recorded['cwd'], str(self.root))
            self.assertEqual(recorded['source'], 'current fixture identity')
            self.assertEqual(recorded['args'][-1], 'task-7-happy.json' if destination == '7' else destination)
            self.assertFalse((self.root / '.omo/cliproxy-qa.lock.d').exists())
        env['RECORDER_EXIT'] = '9'
        result = self.run_process(['bash', str(scripts / 'run-case-locked.sh'), 'proxy', 'happy', '8'], env=env)
        self.assertEqual(result.returncode, 9)
        self.assertFalse((self.root / '.omo/cliproxy-qa.lock.d').exists())

    def test_wrappers_preserve_receipts_sentinels_and_foreign_locks(self):
        scripts, evidence, recorder, env = self.wrappers()
        existing = evidence / 'task-1-happy.json'
        existing.write_text('existing receipt')
        sentinel = evidence.parent / 'outside-sentinel.json'
        sentinel.write_text('outside sentinel')
        link = evidence / 'escape'
        link.symlink_to(evidence.parent, target_is_directory=True)
        cases = [('run-case-locked.sh', []),
                 ('run-case-locked.sh', ['proxy', 'happy', '../outside-sentinel']),
                 ('run-case-locked.sh', ['proxy', 'happy', '1']),
                 ('run-f3-locked.sh', ['proxy', 'happy', '../outside-sentinel.json']),
                 ('run-f3-locked.sh', ['proxy', 'happy', 'escape/outside-sentinel.json']),
                 ('run-f3-locked.sh', ['missing', 'happy', 'new.json']),
                 ('run-f3-locked.sh', ['proxy', 'bogus', 'new.json']),
                 ('run-f3-locked.sh', ['desktop-parity', 'happy', 'new.json'])]
        env['MAHOQUOT_ALLOW_SCREEN_QA'] = '1'
        for wrapper, args in cases:
            result = self.run_process(['bash', str(scripts / wrapper), *args], env=env)
            self.assertNotEqual(result.returncode, 0, args)
            self.assertFalse(recorder.exists())
        self.assertEqual(existing.read_text(), 'existing receipt')
        self.assertEqual(sentinel.read_text(), 'outside sentinel')
        lock = self.root / '.omo/cliproxy-qa.lock.d'
        lock.mkdir()
        (lock / 'foreign').write_text('owned by someone else')
        result = self.run_process(['bash', str(scripts / 'run-f3-locked.sh'), 'proxy', 'happy', 'new.json'], env=env)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((lock / 'foreign').read_text(), 'owned by someone else')
        self.assertFalse(recorder.exists())

    def oracle_args(self, routes):
        path = self.root / 'routes.json'
        path.write_text(json.dumps({'test': routes}))
        return ['oracle', '--oracle', '127.0.0.1:18880', '--mine', '127.0.0.1:18881',
                '--secret', 'fixture-only', '--routes', str(path)]

    def test_transport_errors_never_match(self):
        args = self.oracle_args(['GET /debug'])
        output = io.StringIO()
        with patch.object(sys, 'argv', args), patch.object(ORACLE.urllib.request, 'build_opener') as opener:
            opener.return_value.open.side_effect = urllib.error.URLError('fixture refusal')
            with contextlib.redirect_stdout(output):
                code = ORACLE.main()
        self.assertEqual(code, 1)
        self.assertIn('MATCH 0/1', output.getvalue())
        self.assertEqual(opener.return_value.open.call_count, 2)

    def test_valid_match_and_genuine_mismatch_exit_codes(self):
        for responses, expected in [([(200, '{"a":1}'), (200, '{"a":2,"b":3}')], 0),
                                    ([(200, '{"a":1}'), (200, '{"b":1}')], 1),
                                    ([(200, '{}'), (500, '{}')], 1)]:
            with patch.object(sys, 'argv', self.oracle_args(['GET /debug'])), \
                    patch.object(ORACLE, 'call', side_effect=responses), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(ORACLE.main(), expected)

    def test_write_plan_rejected_before_failed_get_or_any_put(self):
        with patch.object(sys, 'argv', self.oracle_args(['GET /config.yaml', 'PUT /config.yaml'])), \
                patch.object(ORACLE, 'call', return_value=(500, 'invalid config')) as call, \
                contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit) as error:
                ORACLE.main()
        self.assertEqual(error.exception.code, 2)
        call.assert_not_called()


if __name__ == '__main__':
    unittest.main()
