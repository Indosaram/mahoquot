#!/bin/bash
# Serialize wire-QA case runs: every case binds fixed ports 18840/18841.
# Usage: scripts/qa/run-case-locked.sh <case> <happy|failure> <task-number>
set -u
# desktop-parity drives the real app on the user's screen (cursor warp,
# window activation, clicks, tray Quit). It never runs unless asked for.
if [ "$1" = "desktop-parity" ] && [ "${MAHOQUOT_ALLOW_SCREEN_QA:-}" != "1" ]; then
  echo "SKIP desktop-parity: drives the real screen; set MAHOQUOT_ALLOW_SCREEN_QA=1 to run it" >&2
  exit 3
fi
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
rm -f "/Volumes/T9-Mac/project/mahoquot-wt/cliproxy-remediation-w1/.omo/evidence/cliproxy-remediation/6417c774-c554-4c53-880b-d8355082043e/task-$3-$2.json"
bun scripts/qa/cliproxy-parity.mjs --case "$1" --variant "$2" --evidence "task-$3-$2.json"
