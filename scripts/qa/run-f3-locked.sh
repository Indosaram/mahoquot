#!/bin/bash
set -eu
LOCK=/Volumes/T9-Mac/tmp/cliproxy-qa.lock.d
mkdir -p /Volumes/T9-Mac/tmp
until mkdir "$LOCK" 2>/dev/null; do
  if [ -f "$LOCK/pid" ] && ! kill -0 "$(cat "$LOCK/pid")" 2>/dev/null; then rm -rf "$LOCK"; continue; fi
  sleep 2
done
echo $$ > "$LOCK/pid"
trap 'rm -rf "$LOCK"' EXIT

cd /Volumes/T9-Mac/project/mahoquot-wt/cliproxy-remediation-w1
export MAHOQUOT_QA_EVIDENCE_ROOT=/Volumes/T9-Mac/project/mahoquot-wt/cliproxy-remediation-w1/.omo/evidence/cliproxy-remediation/6417c774-c554-4c53-880b-d8355082043e
export NO_COLOR=1
export CLICOLOR=0
export TERM=dumb

mkdir -p "$MAHOQUOT_QA_EVIDENCE_ROOT/f3"
rm -f "$MAHOQUOT_QA_EVIDENCE_ROOT/$3"

bun scripts/qa/cliproxy-parity.mjs --case "$1" --variant "$2" --evidence "$3"
