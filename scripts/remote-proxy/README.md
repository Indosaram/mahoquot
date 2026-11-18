# mahoquot-remote-proxy

Local TCP relay from this machine to the remote `mahoquot-gateway`.

```
127.0.0.1:18801            → 100.91.254.71:18801   (mhc, desktop app, MAHOQUOT_URL)
<tailnet 100.64/10>:18801  → 100.91.254.71:18801   (other tailnet devices)
```

## Why it exists

`ssh -L 18801` over Tailscale SSH wedged after roughly ten seconds of streaming traffic and
left every `localhost:18801` request hanging. Proxy clients cannot be pointed at the remote
gateway directly without exposing the gateway key on every device, so a small standalone TCP
relay owns the port instead. It replaced a 29-line script whose socket handling leaked
connections until the fd table was exhausted.

## Contract

The relay keeps one invariant that matters: **every accepted pair is closed**. A connection is
torn down when either side closes, errors, or exceeds its deadline, so file descriptors return
immediately.

- Half-close is legal. A client may send its request and shut down its write side while the
  response is still streaming. The relay therefore arms `FIN_GRACE_MS` on FIN, and **restarts
  that deadline on every byte**, only reclaiming pairs that have genuinely gone quiet.
  Tearing down on FIN would truncate every streamed response.
- Upstream connect is bounded by `CONNECT_TIMEOUT_MS`, so an unreachable gateway cannot hold
  slots.
- TCP keepalive (30s) reaps peers that vanish without FIN/RST.
- A watchdog exits the process when its fd count passes `FD_MAX * FD_WARN_RATIO`; launchd
  restarts it into a clean fd table. This is deliberate — leaking under load is worse than a
  one-second restart.

These two behaviours are pinned by `scripts/tests/remote-proxy-relay.test.mjs`, which fails
against the previous implementation.

## Install

```bash
node scripts/remote-proxy/install.mjs            # writes both LaunchAgents and bootstraps them
node scripts/remote-proxy/install.mjs --dry-run  # print the plists only
```

Options: `--target-host`, `--target-port`, `--listen-host`, `--listen-port`, `--fd-max`,
`--ssh-target`.

The installer copies `relay.mjs` to `~/.omo/bin/mahoquot-remote-proxy.mjs` and loads **two**
agents with `NumberOfFiles = FD_MAX`: the relay `ai.indo.mahoquot-remote-proxy` and the OAuth
callback tunnel `ai.indo.mahoquot-remote-forward`. Logs go to `~/.mahoquot/remote-proxy.log`.

```bash
launchctl kickstart -k gui/$(id -u)/ai.indo.mahoquot-remote-proxy   # restart relay
launchctl bootout gui/$(id -u)/ai.indo.mahoquot-remote-forward      # stop tunnel
```

## The OAuth callback tunnel

The gateway binds its browser-redirect callback listeners to `127.0.0.1` on the host it runs
on (`crates/gateway/src/management/oauth.rs`, `bind_callback_listener`), and the
`redirect_uri` it hands the browser is `localhost:<port>` because those client IDs are
registered with the providers. With a remote gateway those are two different loopbacks, so a
local browser can never reach the listener without a tunnel. Ports: `antigravity` 51121,
`codex` 1455, `anthropic` 54545, `command-code` 5959.

The listeners are per-login and expire after `OAUTH_SESSION_TTL` (1800s), so the tunnel is idle
most of the time. It stays resident because an `ssh -N` with four `-L` flags is one process and
no browser login completes without it.

### A second machine

The tunnel targets `indo@100.91.254.71` regardless of which machine runs it, so a new Mac needs
only: that machine's SSH key in the remote `~/.ssh/authorized_keys` (the agent uses
`BatchMode=yes`, so a passphrase prompt fails instead of hanging) and the remote host in its
`known_hosts`. Then run the installer there with the same `--ssh-target`.

Check it: `launchctl print gui/$(id -u)/ai.indo.mahoquot-remote-forward` shows
`state = running`, and `nc -vz 127.0.0.1 1455` connects.

## Verify

```bash
node --test scripts/tests/remote-proxy-relay.test.mjs
lsof -nP -iTCP:18801 -sTCP:LISTEN
```

`stats` lines in the log report `accepted` and `closed`. Under load they must stay equal; a gap
means pairs are accumulating, which is exactly the regression the test covers.
