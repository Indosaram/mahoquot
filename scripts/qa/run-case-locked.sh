#!/bin/bash
set -euo pipefail
if [[ $# != 3 || ! "$3" =~ ^[1-9][0-9]*$ ]]; then
  echo 'usage: run-case-locked.sh <case> <happy|failure> <positive-task-number>' >&2
  exit 2
fi
exec bash "$(cd "$(dirname "$0")" && pwd)/run-f3-locked.sh" "$1" "$2" "task-$3-$2.json"
