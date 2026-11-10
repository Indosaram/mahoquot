#!/usr/bin/env bash
set -euo pipefail

# The historical receipts were scenario templates, not authenticated native
# observations. No supported observer currently binds the complete native build,
# source closure and individual capability measurements to these certificates.
# Fail closed rather than relabel arbitrary JSON (even pass-shaped JSON) as proof.
# Keep this entrypoint so historical callers get an explicit non-success result.
printf '%s\n' '{"verdict":"reject","code":"native_observer_unavailable","detail":"Synthetic, historical and caller-supplied receipts cannot certify native capabilities. An isolated native observer and source/build binding are required; no certificate was written."}' >&2
exit 1
