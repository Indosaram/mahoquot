#!/usr/bin/env bash
# Re-applies the Android network policy after `tauri android init`, which
# regenerates gen/android from scratch. Idempotent.
#
#   ./scripts/patch-android.sh
#   MAHOQUOT_ANDROID_CLEARTEXT=all ./scripts/patch-android.sh
#
# Security: the default permits cleartext only for loopback and the emulator's
# host alias. `all` is required to reach a gateway on a LAN IP, because Android
# <domain> entries cannot express RFC 1918 ranges.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd -P)"
root="$(cd "$here/.." && pwd -P)"
src="$root/android"
gen="$root/gen/android/app/src/main"

if [ ! -d "$gen" ]; then
  echo "patch-android: $gen not found; run 'tauri android init' first" >&2
  exit 1
fi

mode="${MAHOQUOT_ANDROID_CLEARTEXT:-loopback}"
case "$mode" in
  loopback) config="$src/network_security_config.xml" ;;
  all)      config="$src/network_security_config_allow_all.xml" ;;
  *) echo "patch-android: unknown MAHOQUOT_ANDROID_CLEARTEXT=$mode (use loopback|all)" >&2; exit 2 ;;
esac

mkdir -p "$gen/res/xml"
cp "$config" "$gen/res/xml/network_security_config.xml"

manifest="$gen/AndroidManifest.xml"
if ! grep -q 'android:networkSecurityConfig' "$manifest"; then
  /usr/bin/sed -i '' \
    's#<application#<application android:networkSecurityConfig="@xml/network_security_config"#' \
    "$manifest"
fi

echo "patch-android: applied $mode network security config"
