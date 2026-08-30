# Reference parity

What Quotio actually implements from its two references, and what it does not.

- Reference implementations: `../opencodex` and the vendored CLIProxyAPI sources under `.omo/upstream`.
- Executable coverage map: `crates/gateway/tests/data/reference-parity.json`, enforced by `crates/gateway/tests/t20_reference_parity.rs`.
- Frozen reference registry: `docs/reference/opencodex-registry-snapshot.json`, regenerated with `bun scripts/sync-provider-snapshot.mjs`.
- Declared differences: `docs/reference/provider-parity-deviations.json`, enforced by `provider-catalog.test.ts`.

## What "81 providers" means

The reference registry has 83 provider ids. The catalog ships 81 of them, and they are
not 81 separate integrations:

| Auth kind | Count | What onboarding actually does |
|---|---|---|
| `oauth` | 8 | A dedicated browser or device flow implemented in `management/oauth.rs` |
| `forward` | 1 | Codex login, forwarded to the upstream session |
| `local` | 3 | Local endpoint, saved without a key |
| `key` | 69 | Paste an API key; the account rides a shared adapter |

Adapter distribution is the other half of the picture: 67 of the 81 ride
`openai-chat`, 5 ride `anthropic`, 3 ride `google`, 3 ride `openai-responses`, and
`cursor`, `kiro` and `command-code` own one each.

So the honest claim is: **8 dedicated auth flows plus 7 relay adapters carry all 81
providers.** A provider row in the manifest declares which of the two it is — a
`dedicated` row names its own GREEN test, an `adapter` row rides the adapter's.
Nothing claims a per-provider test that does not exist.

## Deliberate omissions

Two reference providers are not shipped, because porting the entry without its auth
flow would onboard accounts that cannot authenticate. Each is declared with a reason in
`provider-parity-deviations.json`; the gate rejects an omission without a reason, an
omission that still has a manifest row, and an omitted provider that reappears in the
catalog.

| Provider | Why it is not shipped |
|---|---|
| `mimo-free` | The reference mints an anonymous bootstrap JWT and adds `X-Mimo-Source`, `x-session-affinity` and an anti-abuse system marker (`opencodex/src/adapters/mimo-free.ts`). That flow is not ported, and the free tier issues no pasteable token. |
| `azure-openai` | The reference routes Azure through its Responses passthrough (`opencodex/src/adapters/azure.ts`). Quotio relays the chat-completions path, which is not the wire Azure deployments answer on. |

Two catalog fields deliberately differ from the reference; each is declared with a
reason in the same file (`kiro` auth kind, `command-code` label).

## What the gate does and does not prove

`t20_reference_parity` is a coverage map, not a behaviour proof. It verifies that every
reference-backed flow, every relay adapter and every catalog provider still has a named
owner and a named test that exists, that no adapter row is dead, that partial ports
declare their gap, that every reference provider is either covered or explicitly
omitted, and that provider metadata still matches the frozen reference snapshot. The
behaviour itself is proven by the tests it names.

Locators are matched by needle, not by line, so editing above a symbol cannot turn the
gate red. Reference locators are verified only when the sibling checkout is present; the
tracked snapshot carries the parity proof so a clone without `../opencodex` still runs
the gate at full strength on everything in-repo.
