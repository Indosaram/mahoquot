#!/bin/bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd -P)"
exec python3 - "$root" "$@" <<'PY'
import os
from pathlib import Path
import re
import subprocess
import sys

def main():
    if len(sys.argv) != 5:
        raise ValueError('usage: run-f3-locked.sh <case> <happy|failure> <relative-receipt.json>')
    root, case, variant, receipt = Path(sys.argv[1]), *sys.argv[2:]
    if not re.fullmatch(r'[a-z][a-z0-9-]*', case):
        raise ValueError('invalid case')
    if case != 'fixture' and not (root / 'scripts/qa/cases' / (case + '.mjs')).is_file():
        raise ValueError('unknown case')
    if variant not in ('happy', 'failure'):
        raise ValueError('invalid variant')
    # Root/orchestrator must verify an actual disposable guest and obtain
    # separate screen permission. Neither is established yet. HOME and caller
    # JSON/flags cannot admit the shared login. Deny before any mutation.
    if case == 'desktop-parity':
        raise ValueError('desktop-parity blocked: root-verified disposable guest and separate screen authorization pending (K1)')
    parts = receipt.split('/')
    if any(not re.fullmatch(r'[A-Za-z0-9_-]+(?:\.json)?', p) for p in parts) or not receipt.endswith('.json'):
        raise ValueError('invalid relative receipt path')
    base = root / '.omo/evidence/cliproxy-remediation'
    value = os.environ.get('MAHOQUOT_QA_EVIDENCE_ROOT', '')
    evidence = Path(value)
    if not evidence.is_absolute():
        raise ValueError('MAHOQUOT_QA_EVIDENCE_ROOT must be explicit and absolute')
    # Reject symlink components, including a dangling final destination, before
    # any mkdir or lock mutation. Do not delete or replace existing receipts.
    destination = evidence / receipt
    for path in (base, evidence, destination):
        if path.is_symlink() or any(p.is_symlink() for p in path.parents):
            raise ValueError('symlink evidence paths are unsupported')
    if base.resolve() not in evidence.resolve().parents:
        raise ValueError('evidence root escapes current checkout evidence base')
    if evidence.resolve() not in destination.resolve().parents:
        raise ValueError('receipt escapes evidence root')
    if destination.exists():
        raise ValueError('evidence receipt already exists')
    # One checkout-wide lock covers the fixed QA ports. An explicit private
    # lock parent can coordinate multiple checkouts. Contention fails promptly;
    # never poll, steal a stale lock, or remove another invocation\'s state.
    lock_parent = Path(os.environ.get('MAHOQUOT_QA_LOCK_ROOT', str(root / '.omo')))
    if not lock_parent.is_absolute() or not lock_parent.is_dir():
        raise ValueError('lock root must be an existing absolute directory')
    if lock_parent.is_symlink() or any(p.is_symlink() for p in lock_parent.parents):
        raise ValueError('symlink lock roots are unsupported')
    if lock_parent.stat().st_uid != os.getuid() or lock_parent.stat().st_mode & 0o022:
        raise ValueError('lock root must be owned and not group/world writable')
    lock = lock_parent / 'cliproxy-qa.lock.d'
    lock.mkdir(mode=0o700)
    identity = lock.stat()
    try:
        # Recheck after acquiring the shared lock before dispatch.
        if destination.exists() or destination.is_symlink():
            raise ValueError('evidence receipt already exists')
        env = dict(os.environ, NO_COLOR='1', CLICOLOR='0', TERM='dumb')
        return subprocess.run(['bun', 'scripts/qa/cliproxy-parity.mjs', '--case', case,
                               '--variant', variant, '--evidence', receipt], cwd=root, env=env).returncode
    finally:
        current = lock.lstat()
        if (identity.st_dev, identity.st_ino) != (current.st_dev, current.st_ino):
            raise RuntimeError('lock ownership changed; refusing cleanup')
        lock.rmdir()

try:
    sys.exit(main())
except (OSError, ValueError, RuntimeError) as error:
    print(str(error), file=sys.stderr)
    sys.exit(2)
PY
