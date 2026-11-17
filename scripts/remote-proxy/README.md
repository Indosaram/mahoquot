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
node scripts/remote-proxy/install.mjs            # writes the LaunchAgent and bootstraps it
node scripts/remote-proxy/install.mjs --dry-run  # print the plist only
```

Options: `--target-host`, `--target-port`, `--listen-host`, `--listen-port`, `--fd-max`.

The installer copies `relay.mjs` to `~/.omo/bin/mahoquot-remote-proxy.mjs` and loads
`ai.indo.mahoquot-remote-proxy` with `NumberOfFiles = FD_MAX`. Logs go to
`~/.mahoquot/remote-proxy.log`.

```bash
launchctl kickstart -k gui/$(id -u)/ai.indo.mahoquot-remote-proxy   # restart
launchctl bootout gui/$(id -u)/ai.indo.mahoquot-remote-proxy        # stop
```

## Verify

```bash
node --test scripts/tests/remote-proxy-relay.test.mjs
lsof -nP -iTCP:18801 -sTCP:LISTEN
```

`stats` lines in the log report `accepted` and `closed`. Under load they must stay equal; a gap
means pairs are accumulating, which is exactly the regression the test covers.
