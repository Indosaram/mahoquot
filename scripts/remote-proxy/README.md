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
node scripts/remote-proxy/install.mjs            # writes the relay LaunchAgent and bootstraps it
node scripts/remote-proxy/install.mjs --dry-run  # print the plist only
```

Options: `--target-host`, `--target-port`, `--listen-host`, `--listen-port`, `--fd-max`.

The installer copies `relay.mjs` to `~/.omo/bin/mahoquot-remote-proxy.mjs` and loads the agent
`ai.indo.mahoquot-remote-proxy` with `NumberOfFiles = FD_MAX`. Logs go to
`~/.mahoquot/remote-proxy.log`.

```bash
launchctl kickstart -k gui/$(id -u)/ai.indo.mahoquot-remote-proxy   # restart relay
```

## OAuth callbacks from a remote gateway

The gateway binds its browser-redirect listeners to `127.0.0.1` on the host it runs on, and
hands the browser a `localhost:<port>` `redirect_uri`, because those client IDs are registered
with the providers. With a remote gateway those are two different loopbacks, so the browser's
redirect lands on the wrong machine and the login stalls after the provider has already
approved it. Ports: `antigravity` 51121, `codex` 1455, `anthropic` 54545, `command-code` 5959.

**The desktop app handles this itself** (`crates/monitor-ui/src/oauth_callback.rs`). When the
configured gateway is not the local one, the app listens on those four ports and replays each
redirect at the gateway's public `/oauth-callback` route, which finds the pending session by
its `state` and performs the token exchange server side. Nothing has to be installed or
registered per machine beyond the app itself, and no SSH key is involved.

This replaced an `ssh -L` tunnel that had to be hand-written on every machine. The tunnel
worked, but a machine that installed the app and the relay still had dead logins until someone
remembered to recreate the forward — which is exactly what a new machine gets wrong. The
forwarder is now part of the app, so the app alone is sufficient on any Mac.

If a port is already taken by something else the app logs it and serves the remaining
providers; a login on the busy provider finishes inside the gateway's own management UI
instead, which is only reachable when you are on the gateway's host.

## Verify

```bash
node --test scripts/tests/remote-proxy-relay.test.mjs
lsof -nP -iTCP:18801 -sTCP:LISTEN
```

`stats` lines in the log report `accepted` and `closed`. Under load they must stay equal; a gap
means pairs are accumulating, which is exactly the regression the test covers.
