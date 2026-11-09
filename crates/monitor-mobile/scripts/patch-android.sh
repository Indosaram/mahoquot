#!/usr/bin/env bash
# Re-applies the Android network policy after `tauri android init`, which
# regenerates gen/android from scratch. Idempotent.
#
# Security: the mobile app is remote-only and reaches a gateway over a private
# overlay that serves plain HTTP, so cleartext must be permitted. Android
# <domain> entries cannot express an arbitrary overlay IP, so the policy is
# global; any endpoint configured with https:// still uses TLS.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd -P)"
root="$(cd "$here/.." && pwd -P)"
gen="$root/gen/android/app/src/main"

if [ ! -d "$gen" ]; then
  echo "patch-android: $gen not found; run 'tauri android init' first" >&2
  exit 1
fi

mkdir -p "$gen/res/xml"
cp "$root/android/network_security_config.xml" "$gen/res/xml/network_security_config.xml"

manifest="$gen/AndroidManifest.xml"
if ! grep -q 'android:networkSecurityConfig' "$manifest"; then
  /usr/bin/sed -i '' \
    's#<application#<application android:networkSecurityConfig="@xml/network_security_config"#' \
    "$manifest"
fi

echo "patch-android: applied network security config"
