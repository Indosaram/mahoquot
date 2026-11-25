# omo-profile-sync

Keeps the mahoquot model settings of every machine's omo install identical, from one place.

## What it does

- The source of truth (SOT) is the "omo profile" stored in the gateway, behind
  `GET` / `PUT /v0/management/omo-profile`. The response carries `{revision, updated_at, compat, models, remove}`
  and an `ETag: "r<revision>"`. `PUT` requires `If-Match` (lost updates are rejected with 412).
- The agent (`sync.ts`, bun) runs on each machine every 60 s. It fetches the profile (conditional on the last
  ETag, so an unchanged profile is a cheap 304) and merges `providers.mahoquot.models[]` into both
  `~/.omo/agent/models.json` and `~/.omo/models.json` (one unit per entry, keyed by `id`, the whole object).
  `providers.mahoquot.compat` is read and hashed but never written by merge.
- Gateway URL and key come from the first existing target's `providers.mahoquot.baseUrl` (a trailing `/v1` is
  stripped) and `apiKey`. `MAHOQUOT_URL` overrides the URL.
- Both files are parsed and merged in memory first; if either fails to parse, nothing is written.

## What it never touches

- Any provider other than `mahoquot`, and `providers.mahoquot.apiKey`, `baseUrl`, `name`, `api`.
- `disabledProviders`, unknown keys, `settings.json`, `omo.json`, `auth.json`.
- `providers.mahoquot.compat`, including its absence and any custom fields.
- It never creates `providers.mahoquot` (the file is skipped and logged), and it never prunes or decides
  anything from `/v1/models`.

## Deleting a model

The merge returns a deletion change for every local model absent from SOT `models`, regardless of its hash.
Changes have `reason: "tombstone"` for ids in `remove`, or `reason: "local-only"` otherwise.
An id listed in both `models` and `remove` is kept. Merge performs no file I/O; its caller owns backups and writes.

## Conflicts

Merge returns hashes for every final-state unit, including read-only local `compat`, and null hashes for removed
units. Model conflicts describe resolved differences, not vetoes. Conflicts are logged as
`CONFLICT <file> <unit> <kind>` and counted under `conflicts=`.

| Condition | Model decision | Report |
| --- | --- | --- |
| SOT present, local absent | Add unconditionally, independent of revision | `locally-removed` if previously tracked |
| SOT present, local equals SOT | No change; record final hash | None |
| SOT present, local equals recorded hash | Update to SOT | None |
| SOT present, local differs, no recorded hash | Overwrite with SOT | `unmanaged-differs`, `resolution: "overwritten"` |
| SOT present, local differs from SOT and recorded hash | Overwrite with SOT | `local-edit`, `resolution: "overwritten"` |
| Local present, absent from SOT models and remove | Delete | Change reason `local-only` |
| Local present, tombstoned (not in models) | Delete unconditionally | Change reason `tombstone` |
| Duplicate local id | Apply the same decision to every occurrence | `duplicate-local-id` for every extra occurrence |

`compat` is never added, overwritten, or removed; its existing conflict detection remains observational.
`--adopt-sot` remains a manual forced-refetch option; models already use SOT-authoritative decisions without it,
and it does not authorize writing `compat`. Review a `--dry-run` first.

After a run with conflicts the agent does not store the ETag, so it re-evaluates every cycle until the conflict is
resolved. When the gateway answers 304, the agent replays the profile cached in `state.json`, so a local edit made
between runs is still overwritten by the unchanged SOT instead of surviving until the SOT's next revision.

## Files

All under `~/.omo/omo-profile-sync/` unless noted (`C:/Users/<user>/...` on Windows):

| File | Purpose |
| --- | --- |
| `state.json` | Last ETag, the last applied profile, and the per-unit applied hashes (shared by both models files). The file is only rewritten when its canonical contents change. |
| `lock` | pid lock so runs never overlap; stale when the pid is dead or older than 10 min. |
| `sync.log`, `sync.log.1` | Run log; rotated to `.1` at 1 MiB. |
| `~/.omo/backups/<YYYYMMDDTHHMMSSZ>/` | One directory for all targets in a write run; newest 20 run directories retained, oldest deleted first. Same-second runs get a numeric suffix. |
| `manifest.json` (inside the backup directory) | Original absolute paths, backup filenames and file modes used by restore. |
| `report.json` (inside the backup directory) | `{timestamp, sotRevision, applied[], pruned[], overwritten[], removed[], conflicts[]}` with a target `path` on each entry. |
| `launchd.log` | macOS only: stdout/stderr of the LaunchAgent. |

Every write is atomic (temp file, fsync, rename) and re-parsed afterwards; a failed write restores the backups.
Gateway unreachable, 401/403, an invalid payload, or revision 0 leaves the files untouched.

`--dry-run` prints the same report JSON to stdout, with diagnostics on stderr, and writes nothing:
no models files, state, log, backup directory, or report file. `applied` lists additions and updates;
`pruned` lists local-only deletions; `removed` lists all deletions, including tombstones;
`overwritten` lists conflicts resolved by SOT overwrite. Counters count entries across all targets.
The daemon emits one summary line:
`revision=R changed=C skipped=S applied=N pruned=M overwritten=K conflicts=J`.
A run aborted before any target write produces no report. If a later write fails, the attempted-change
report remains beside the backups; the log records the failure and rollback outcome.

## Restore a backup

```sh
bun scripts/omo-profile-sync/sync.ts --restore ~/.omo/backups/20260101T000000Z
```

This restores every file in `manifest.json` to its original path, including its saved mode, under the
same run lock. It makes no gateway request and clears the cached ETag so the next daemon cycle
re-converges to SOT even if its revision has not changed. Restore is a **temporary bypass**, not a
permanent rollback: edit the SOT for a lasting change. `--adopt-sot` remains a one-shot manual option.
Restore cannot be combined with dry-run, adopt, or seed flags.

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

The gateway derives the SOT itself from its routable catalog every 300 s, so the normal way to change it is to
change what the gateway can route (register a provider, remove a model). Manual edits below still work for a
one-off correction, but the next derivation tick will overwrite `models` with the catalog projection.

```sh
bun scripts/omo-profile-sync/sync.ts --export-seed > p.json   # edit p.json
bun scripts/omo-profile-sync/sync.ts --push-seed p.json
```

- `--export-seed` prints `{compat, models, remove: []}` taken from the local `providers.mahoquot`.
- `--push-seed <file>` GETs the current profile for its ETag, then PUTs the file with `If-Match` set to it, and
  prints the new revision. If someone else changed the profile in between, the gateway answers 412; the command
  exits 1 and explains. Re-export, re-apply your edit, and push again.

To delete a model everywhere, move its id into `remove` (and drop it from `models`). To change one, edit its entry
in `models`; local model edits are overwritten on the next merge and reported with `resolution: "overwritten"`.

## Troubleshooting

- `auth: gateway returned 401` in the log: wrong `providers.mahoquot.apiKey` on that machine (scoped keys get 403).
- Gateway down or timing out (10 s): logged as `unreachable`, no-op, exit 0. It retries on the next cycle.
- `profile is unset (revision 0)`: the SOT has not been seeded yet. Export from a machine and `--push-seed` it.
- `no providers.mahoquot with baseUrl and apiKey`: that machine has no mahoquot provider; the agent will not create one.
- `another run holds the lock`: a previous run is still going; it exits 0. A dead or 10-minute-old lock is replaced.
- Something looks wrong after a write: use `--restore <backup-dir>` with the matching directory under `~/.omo/backups/` (temporary until the next sync).
