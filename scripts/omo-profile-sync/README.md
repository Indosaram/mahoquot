# omo-profile-sync

Keeps the mahoquot model settings of every machine's omo install identical, from one place.

## What it does

- The source of truth (SOT) is the "omo profile" stored in the gateway, behind
  `GET` / `PUT /v0/management/omo-profile`. The response carries `{revision, updated_at, compat, models, remove}`
  and an `ETag: "r<revision>"`. `PUT` requires `If-Match` (lost updates are rejected with 412).
- The agent (`sync.ts`, bun) runs on each machine every 60 s. It fetches the profile (conditional on the last
  ETag, so an unchanged profile is a cheap 304) and merges **only** these two things into both
  `~/.omo/agent/models.json` and `~/.omo/models.json`:
  - `providers.mahoquot.compat` (one unit, the whole object)
  - `providers.mahoquot.models[]` (one unit per entry, keyed by `id`, the whole object)
- Gateway URL and key come from the first existing target's `providers.mahoquot.baseUrl` (a trailing `/v1` is
  stripped) and `apiKey`. `MAHOQUOT_URL` overrides the URL.
- Both files are parsed and merged in memory first; if either fails to parse, nothing is written.

## What it never touches

- Any provider other than `mahoquot`, and `providers.mahoquot.apiKey`, `baseUrl`, `name`, `api`.
- `disabledProviders`, unknown keys, `settings.json`, `omo.json`, `auth.json`.
- Models that exist only locally (ids that are in neither the SOT `models` nor `remove`).
- It never creates `providers.mahoquot` (the file is skipped and logged), and it never prunes or decides
  anything from `/v1/models`.

## Deleting a model

A model is removed only when its id is in the SOT `remove` list, and only if the local copy is still exactly what
the agent last applied. A model that merely stops being advertised is left alone. An id listed in both `models`
and `remove` is kept.

## Conflicts

The agent records a hash of every unit it applied. A unit it cannot safely overwrite is skipped, left exactly as it
is locally, and logged as a `WARN` line: `CONFLICT <file> <unit> <kind>` (unit is `compat` or `model:<id>`).
The summary line counts it under `conflicts=`.

| Kind | Meaning | Resolve |
| --- | --- | --- |
| `local-edit` | The unit was changed by hand after the last sync (or a tombstoned model was). | Keep the edit: copy it into the SOT. Discard it: run `--adopt-sot` once. |
| `unmanaged-differs` | The id/`compat` exists locally, was never synced from the SOT, and differs from it (typical on first rollout). Also raised for a `remove` id that was never synced. | Edit the SOT to match the local copy, or run `--adopt-sot` once (local entry is overwritten, or deleted for a `remove` id). |
| `locally-removed` | The unit was synced earlier but is now missing locally. `--adopt-sot` does not re-add it. | To accept the removal, add the id to the SOT `remove` list. To get it back, re-add the entry by hand, then run `--adopt-sot` once if it now reports `local-edit`. |
| `duplicate-local-id` | A managed id appears more than once in the local `models[]`. The first entry is the unit; the later ones are left untouched. | Delete the extra entries by hand. |

`--adopt-sot` is a one-shot "SOT wins" run: `sync.ts --adopt-sot` overwrites conflicting `compat` and model units
(backups are kept) and always refetches regardless of the ETag. Run it manually, not from the service.
Review a `--dry-run` first.

After a run with conflicts the agent does not store the ETag, so it re-evaluates every cycle until the conflict is
resolved.

## Files

All under `~/.omo/omo-profile-sync/` unless noted (`C:/Users/<user>/...` on Windows):

| File | Purpose |
| --- | --- |
| `state.json` | Last ETag plus the per-unit applied hashes (shared by both models files). |
| `lock` | pid lock so runs never overlap; stale when the pid is dead or older than 10 min. |
| `sync.log`, `sync.log.1` | Run log; rotated to `.1` at 1 MiB. |
| `<models file>.bak-profilesync-<ISO time>` | Backup taken next to each file before every write. The newest 10 per file are kept. |
| `launchd.log` | macOS only: stdout/stderr of the LaunchAgent. |

Every write is atomic (temp file, fsync, rename) and re-parsed afterwards; a failed write restores the backups.
Gateway unreachable, 401/403, an invalid payload, or revision 0 leaves the files untouched.

`--dry-run` prints the per-file changes and conflicts and writes nothing: no models files, no state, no log file.

## Install / uninstall

```sh
bun scripts/omo-profile-sync/install.ts               # install in dry-run mode (service runs with --dry-run)
bun scripts/omo-profile-sync/install.ts --apply       # install, service is allowed to write
bun scripts/omo-profile-sync/install.ts --uninstall   # remove the service and bundle, keep state/logs/backups
```

Optional: `--bundle <path>` installs a prebuilt `omo-profile-sync.js` instead of building from `sync.ts`
(use it when running remotely); `--home <dir>` overrides the home directory. The agent is bundled to
`~/.omo/bin/omo-profile-sync.js`. The service records the bun that ran the installer (`process.execPath`).
Re-running install replaces the existing service, so use it to switch between dry-run and `--apply`.
In dry-run mode the service writes no `sync.log`; output goes to `launchd.log` (macOS) or the journal (Linux).

| OS | Service | Status |
| --- | --- | --- |
| macOS | LaunchAgent `ai.indo.omo-profile-sync` (`~/Library/LaunchAgents`, every 60 s, runs at load) | `launchctl print gui/$UID/ai.indo.omo-profile-sync` |
| Linux | systemd user timer `omo-profile-sync.timer` + `.service` (30 s after boot, then every 60 s) | `systemctl --user list-timers omo-profile-sync.timer` |
| Windows | Scheduled Task `OmoProfileSync` (Interactive logon, at logon + every minute, hidden via `wscript.exe` and `run-hidden.vbs`) | `Get-ScheduledTask OmoProfileSync` |

Windows: run `install.ts` with the bun that is on PATH, because the task stores that exact path:

```powershell
& (Get-Command bun).Source scripts/omo-profile-sync/install.ts --apply
```

On Linux the timer only runs while your user manager is up; enable lingering (`loginctl enable-linger`) on headless hosts.

## Editing the SOT

```sh
bun scripts/omo-profile-sync/sync.ts --export-seed > p.json   # edit p.json
bun scripts/omo-profile-sync/sync.ts --push-seed p.json
```

- `--export-seed` prints `{compat, models, remove: []}` taken from the local `providers.mahoquot`.
- `--push-seed <file>` GETs the current profile for its ETag, then PUTs the file with `If-Match` set to it, and
  prints the new revision. If someone else changed the profile in between, the gateway answers 412; the command
  exits 1 and explains. Re-export, re-apply your edit, and push again.

To delete a model everywhere, move its id into `remove` (and drop it from `models`). To change one, edit its entry
in `models`; machines pick it up within about a minute, except where a `local-edit` conflict is reported.

## Troubleshooting

- `auth: gateway returned 401` in the log: wrong `providers.mahoquot.apiKey` on that machine (scoped keys get 403).
- Gateway down or timing out (10 s): logged as `unreachable`, no-op, exit 0. It retries on the next cycle.
- `profile is unset (revision 0)`: the SOT has not been seeded yet. Export from a machine and `--push-seed` it.
- `no providers.mahoquot with baseUrl and apiKey`: that machine has no mahoquot provider; the agent will not create one.
- `another run holds the lock`: a previous run is still going; it exits 0. A dead or 10-minute-old lock is replaced.
- Something looks wrong after a write: restore the matching `.bak-profilesync-*` file next to the models file.
