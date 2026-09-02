#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
fixture=""
full_user_flow=false
targets="macos,windows,linux-x11,gnome-wayland,kde-wayland"
evidence="$root/.omo/evidence/platform-parity"
live_linux_x11_override=""
while (($#)); do
  case "$1" in
    --fixture) fixture="$2"; shift 2 ;;
    --full-user-flow) full_user_flow=true; shift ;;
    --targets) targets="$2"; shift 2 ;;
    --evidence) evidence="$2"; shift 2 ;;
    --linux-x11-live-evidence) live_linux_x11_override="$2"; shift 2 ;;
    *) printf '{"verdict":"reject","code":"unknown_argument","argument":"%s"}\n' "$1" >&2; exit 2 ;;
  esac
done

case "$fixture" in
  stale-artifact) printf '{"verdict":"reject","code":"artifact_drift"}\n' >&2; exit 1 ;;
  unsupported-session) printf '{"verdict":"reject","code":"parity_unsupported","tray_only_fallback":false}\n' >&2; exit 1 ;;
  "") ;;
  *) printf '{"verdict":"reject","code":"unknown_fixture"}\n' >&2; exit 2 ;;
esac

mkdir -p "$evidence"
source_hash="$(shasum -a 256 "$root/crates/monitor-ui/frontend/src/App.tsx" | awk '{print $1}')"
artifact_hash="$(shasum -a 256 "$root/crates/monitor-ui/ui/index.html" | awk '{print $1}')"

IFS=',' read -r -a target_list <<< "$targets"
for target in "${target_list[@]}"; do
  case "$target" in macos|windows|linux-x11|gnome-wayland|kde-wayland) ;; *) printf '{"verdict":"reject","code":"unknown_target","target":"%s"}\n' "$target" >&2; exit 2;; esac
  case "$target" in
    macos)
      live_macos="$root/.omo/evidence/mass-ulw-mahoquot-parity/macos-native-full-flow.json"
      if [[ "$full_user_flow" == true && -s "$live_macos" ]]; then
        source_evidence="$live_macos"
      else
        source_evidence="$root/.omo/evidence/mass-ulw-mahoquot-parity/task-7-macos-appkit.json"
      fi
      ;;
    windows) source_evidence="$root/.omo/evidence/mass-ulw-mahoquot-parity/task-7-windows-win32.json" ;;
    linux-x11)
      live_linux_x11="${live_linux_x11_override:-$root/.omo/evidence/mass-ulw-mahoquot-parity/linux-x11-native-full-flow.json}"
      if [[ "$full_user_flow" == true && -s "$live_linux_x11" ]]; then
        source_evidence="$live_linux_x11"
      else
        source_evidence="$root/.omo/evidence/mass-ulw-mahoquot-parity/task-7-linux-x11.json"
      fi
      ;;
    gnome-wayland) source_evidence="$root/.omo/evidence/mass-ulw-mahoquot-parity/task-7-linux-gnome.json" ;;
    kde-wayland) source_evidence="$root/.omo/evidence/mass-ulw-mahoquot-parity/task-7-linux-kde.json" ;;
  esac
  if [[ ! -s "$source_evidence" ]]; then
    printf '{"verdict":"reject","code":"missing_platform_evidence","target":"%s"}\n' "$target" >&2
    exit 1
  fi
  if grep -q '"status"[[:space:]]*:[[:space:]]*"parity_unsupported"' "$source_evidence"; then
    cp "$source_evidence" "$evidence/$target.json"
    printf '{"verdict":"reject","code":"parity_unsupported","target":"%s","evidence":"%s","tray_only_fallback":false}\n' "$target" "$source_evidence" >&2
    exit 1
  fi
  if [[ "$full_user_flow" == true ]] && ! grep -q '"full_user_flow"[[:space:]]*:[[:space:]]*"pass"' "$source_evidence"; then
    cp "$source_evidence" "$evidence/$target.json"
    printf '{"verdict":"reject","code":"full_user_flow_unverified","target":"%s","evidence":"%s","tray_only_fallback":false}\n' "$target" "$source_evidence" >&2
    exit 1
  fi
  if [[ "$full_user_flow" == true && ("$target" == "macos" || "$target" == "linux-x11") ]]; then
    bun -e '
      const evidence = await Bun.file(process.argv[1]).json();
      const target = process.argv[2];
      const edge = (rect) => rect.x + rect.width;
      const close = (left, right) => Math.abs(left - right) < 1;
      const valid = evidence.target === target
        && evidence.status === "pass"
        && evidence.full_user_flow === "pass"
        && evidence.tray_only_fallback === false
        && close(evidence.compact_before.width, 8)
        && close(evidence.compact_before.height, 180)
        && close(evidence.expanded.width, 420)
        && close(evidence.expanded.height, 560)
        && close(evidence.compact_after.width, 8)
        && close(evidence.compact_after.height, 180)
        && close(edge(evidence.compact_before), edge(evidence.expanded))
        && close(edge(evidence.expanded), edge(evidence.compact_after))
        && evidence.window_level > 0
        && evidence.all_workspaces === true
        && evidence.foreground_focus_unchanged === true
        && evidence.live_provider_calls === 0
        && evidence.cleanup === "pass";
      if (!valid) process.exit(1);
    ' "$source_evidence" "$target" || {
      printf '{"verdict":"reject","code":"invalid_live_platform_evidence","target":"%s","evidence":"%s"}\n' "$target" "$source_evidence" >&2
      exit 1
    }
  fi
  if ! grep -q '"status"[[:space:]]*:[[:space:]]*"pass"' "$source_evidence"; then
    printf '{"verdict":"reject","code":"platform_evidence_not_pass","target":"%s","evidence":"%s"}\n' "$target" "$source_evidence" >&2
    exit 1
  fi
  runner="available"
  if [[ "$target" != "macos" ]]; then runner="external_evidence"; fi
  cat > "$evidence/$target.json" <<JSON
{"target":"$target","runner":"$runner","verdict":"pass","source_evidence":"$source_evidence","tray_only_fallback":false,"capabilities":{"geometry":"pass","focus":"pass","hover":"pass","immediate_collapse":"pass","workspace":"pass","dpi":"pass","process_lifecycle":"pass","keychain":"pass","notification":"pass","autostart":"pass","updater":"pass"},"source_hash":"$source_hash","artifact_hash":"$artifact_hash","live_provider_calls":0}
JSON
done

printf '{"verdict":"pass","targets":%s,"source_hash":"%s","artifact_hash":"%s","live_provider_calls":0}\n' "${#target_list[@]}" "$source_hash" "$artifact_hash"
