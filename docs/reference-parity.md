# Reference parity

What Quotio actually implements from its two references, and what it does not.

- Reference implementations: `../opencodex` and the vendored CLIProxyAPI sources under `.omo/upstream`.
- Executable coverage map: `crates/gateway/tests/data/reference-parity.json`, enforced by `crates/gateway/tests/t20_reference_parity.rs`.
- Frozen reference registry: `docs/reference/opencodex-registry-snapshot.json`, regenerated with `bun scripts/sync-provider-snapshot.mjs`.
- Declared differences: `docs/reference/provider-parity-deviations.json`, enforced by `provider-catalog.test.ts`.

## What "83 providers" means

The catalog exposes the same 83 provider ids as the reference registry, but they are
not 83 separate integrations:

| Auth kind | Count | What onboarding actually does |
|---|---|---|
| `oauth` | 8 | A dedicated browser or device flow implemented in `management/oauth.rs` |
| `forward` | 1 | Codex login, forwarded to the upstream session |
| `local` | 3 | Local endpoint, saved without a key |
| `key` | 71 | Paste an API key, or bootstrap one; the account rides a shared adapter |

Adapter distribution is the other half of the picture: 67 of the 83 ride
`openai-chat`, 5 ride `anthropic`, 3 ride `google`, 3 ride `openai-responses`, and
`cursor`, `kiro`, `command-code`, `azure-openai` and `mimo-free` own one each.

So the honest claim is: **8 dedicated auth flows plus 9 relay adapters carry all 83
providers.** A provider row in the manifest declares which of the two it is — a
`dedicated` row names its own GREEN test, an `adapter` row rides the adapter's.
Nothing claims a per-provider test that does not exist.

## The two adapters that are not plain key auth

`azure-openai` and `mimo-free` are the only key-kind providers whose onboarding is not
"paste a key and send it as a bearer token".

| Adapter | What it does |
|---|---|
| `azure-openai` | Relays the Responses wire and authenticates with the `api-key` header, never `Authorization`. The catalog ships the host as a `{resource}` template, so a request against an unedited base URL is rejected with that reason instead of reaching a nonexistent host. |
| `mimo-free` | The free tier issues no pasteable key: the account bootstraps an anonymous JWT against `api/free-ai/bootstrap` with a persisted random client id, then sends `X-Mimo-Source`, `x-session-affinity`, a browser `User-Agent` and the anti-abuse system marker the endpoint requires. The JWT expires and re-bootstraps through the same expiry and 401 retry path as an OAuth credential. MiMo credentials are sent only to the canonical host (or loopback, so the flow stays testable). |

Two catalog fields deliberately differ from the reference; each is declared with a
reason in `provider-parity-deviations.json` (`kiro` auth kind, `command-code` label).

## What the gate does and does not prove

`t20_reference_parity` is a coverage map, not a behaviour proof. It verifies that every
reference-backed flow, every relay adapter and every catalog provider still has a named
owner and a named test that exists, that no adapter row is dead, that partial ports
declare their gap, that every reference provider is either covered or explicitly
omitted with a reason, and that provider metadata still matches the frozen reference
snapshot. The behaviour itself is proven by the tests it names.

Locators are matched by needle, not by line, so editing above a symbol cannot turn the
gate red. Reference locators are verified only when the sibling checkout is present; the
tracked snapshot carries the parity proof so a clone without `../opencodex` still runs
the gate at full strength on everything in-repo.
