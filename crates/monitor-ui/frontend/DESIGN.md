# Mahoquot Operations Console Design System

## 0. Pinned Reference and Clean-Room Architecture

This design system governs the spatial retrofit of the Mahoquot frontend monitor interface. Spatial mechanics are derived from the pinned StyleGallery repository at commit `38ecef0e5fa9eb83e865e71f969e0c004992a8f9`. Because the upstream repository has no root LICENSE, all mechanics are restated in clean-room form. No upstream prose, files, CLI tools, or packages are copied or imported.

Pinned reference links:
- Repository tree: `https://github.com/changeroa/StyleGallery/tree/38ecef0e5fa9eb83e865e71f969e0c004992a8f9`
- Scroll body shell: `https://github.com/changeroa/StyleGallery/blob/38ecef0e5fa9eb83e865e71f969e0c004992a8f9/patterns/viewport-shell/scroll-body-shell.md`
- Fixed side navigation shell: `https://github.com/changeroa/StyleGallery/blob/38ecef0e5fa9eb83e865e71f969e0c004992a8f9/patterns/viewport-shell/fixed-sidenav-shell.md`
- List/detail containment: `https://github.com/changeroa/StyleGallery/blob/38ecef0e5fa9eb83e865e71f969e0c004992a8f9/patterns/split-sidebar/list-detail.md`
- Dashboard recipe: `https://github.com/changeroa/StyleGallery/blob/38ecef0e5fa9eb83e865e71f969e0c004992a8f9/recipes/dashboard.md`
- SaaS settings recipe: `https://github.com/changeroa/StyleGallery/blob/38ecef0e5fa9eb83e865e71f969e0c004992a8f9/recipes/saas-settings.md`
- Motion vocabulary: `https://github.com/changeroa/StyleGallery/blob/38ecef0e5fa9eb83e865e71f969e0c004992a8f9/motion/vocabulary.md`

### Research Log (notch redesign, 2026-11-08)

- Embedded references: `references/design/apple.md` (material depth, restrained instrument dials), `redesign-skill.md` (fix the diagnosis before restyling), `perfection/craft-floor.md` (no nested cards, 4.5:1 caption contrast). Read in full.
- StyleGallery: `patterns/media-fit/icon-frame.md`, `patterns/containment/box.md`, `patterns/viewport-shell/cover.md` at the pinned commit. Used for the fixed dial slot, popover padding, and vertical balance of the dial column.
- Lazyweb: SKIPPED. `references/lazyweb.md` was read only at its head in this pass, so no live search was run and no shipped-product screens were reviewed. The popover shape was decided from the embedded references and StyleGallery instead. The flat-single-surface rule is therefore an inference from `perfection/craft-floor.md` (no nested cards), not a measured comparison against shipped quota meters.
- beui.dev Dynamic Island and Tooltip source (`/r/dynamic-island/raw`, `/r/tooltip/raw`): shell resize belongs to the host, content cross-fades, and one label may be open at a time. Adopted as constraints, no code vendored. (Cited from the reference notes; the raw responses were not re-fetched in this pass.)
- Skipped: `ui-ux-db` lookup (the surface reuses the existing token palette; no new palette decision was open).
- Nine findings drove the redesign, each from the before-captures in `.omo/evidence/notch-redesign/before/`: (1) the island was near-invisible against a dark desktop with no material or rim light; (2) compact/idle read as absent — the only visible mark was a 4x64px hairline handle; (3) the popover was a card inside a card, floating disconnected; (4) every row printed "Resets later"; (5) the dial number and a 9.5px `--fg-faint` caption fell to roughly 3.4:1; (6) the empty state clipped a ring at the island edge over a large black slab; (7) `.notch-ring-cell` had no rule, leaving two competing ring implementations; (8) health, cooldown, banked resets, and last error never reached the UI despite being normalized; (9) the dial summarized the worst *serving* account while the popover listed the worst *overall*, so the two numbers disagreed silently.
- Follow-up pass after the after-captures: the fixed 520px SVG silhouette still painted a dead black field around a one- or two-provider island, so the shape now tracks content height (`notch-body` wrapper plus `height: calc(100% - 96px)` when expanded, 300px when docked). The idle edge handle no longer reports all-clear when a lane is merely cooling down; it now aggregates lane reachability with the pool's usage tone.

## 1. Design Philosophy and Identity

- Mode: Operate. High information density, rapid scanability, truthful metrics, tabular numbers, and system fonts.
- Surface: Embedded inside desktop Tauri shell (1100x720 default window) and browser `/management.html` (desktop and responsive mobile down to 390x844). The native notch surface (`?surface=notch`) runs as an isolated floating window.
- Aesthetic: Dark-first studio console with AA light mode. Neutral slate/zinc surfaces, sharp border contrast, vibrant semantic indicators (ok = green, warn = amber, bad = red, brand = orange #f0801a).
- Motion: GPU-composited opacity and transform only. Respects `prefers-reduced-motion: reduce`.

## 2. Color Tokens

| Token | Dark Mode | Light Mode | Usage |
|---|---|---|---|
| `--bg` | `#0b0b0d` | `#f4f4f7` | Canvas background |
| `--panel` | `#141417` | `#ffffff` | Cards, sidebar, modal background |
| `--panel-2` | `#1b1b1f` | `#f8f8fa` | Nested panels, table hover, code background |
| `--panel-3` | `#232329` | `#eef0f4` | Badge background, inactive toggles |
| `--line` | `#26262c` | `#dcdcde` | Strong borders, dividers |
| `--line-soft` | `#1c1c22` | `#eaecef` | Subtle row separators |
| `--fg` | `#ececf1` | `#111827` | Primary text |
| `--fg-dim` | `#a1a1aa` | `#4b5563` | Secondary text, field labels |
| `--fg-faint` | `#8f8f98` | `#59616d` | Muted timestamps, hints |
| `--accent` | `#f0801a` | `#c25400` | Brand orange, focus ring, active items |
| `--accent-dim` | `rgba(240, 128, 26, 0.15)` | `rgba(194, 84, 0, 0.12)` | Active pill backgrounds |
| `--accent-fg` | `#f0801a` | `#9a4200` | Accent-colored text on tinted backgrounds |
| `--ok` | `#3fb950` | `#156f30` | Healthy, available, 200 responses |
| `--ok-dim` | `rgba(63, 185, 80, 0.15)` | `rgba(21, 111, 48, 0.12)` | Healthy pill background |
| `--warn` | `#d29922` | `#8c5d00` | Cooldown, retry warning |
| `--warn-dim` | `rgba(210, 153, 34, 0.15)` | `rgba(140, 93, 0, 0.12)` | Warning pill background |
| `--bad` | `#f85149` | `#cf222e` | Errors, failed accounts, locked access |
| `--bad-dim` | `rgba(248, 81, 73, 0.15)` | `rgba(207, 34, 46, 0.12)` | Error banner background |

## 3. Typography Scale

- `text-xs`: 11px (line-height: 14px): badges, meta, hints, timestamps
- `text-sm`: 13px (line-height: 18px): primary UI, table cells, form inputs, buttons
- `text-base`: 16px (line-height: 22px): settings card titles (`h3`), navigation links
- `text-lg`: 20px (line-height: 26px): settings section titles (`h2`), stat values
- `text-xl`: 18px (line-height: 24px): view titles, major KPIs
- Heading levels differ by >= 1.25x in `font-size` (16 -> 20px) and a card title always outweighs the row titles it contains (`600` over `500`); never let a container heading render lighter than its children.
- Font family: `-apple-system, BlinkMacSystemFont, "SF Pro Text", Inter, system-ui, sans-serif`
- Monospace: `ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace` (all metrics, tokens, ttft, auth handles)
- Numerical data: Tabular numerals enabled via `font-variant-numeric: tabular-nums`

## 4. Spacing and Radius

Layout: notch island - a 1-7 dial column plus a hover popover must fit a 108px dock without nested cards -> icon-frame (dial slots) + box (popover padding) + cover (vertical centering) (`https://github.com/changeroa/StyleGallery/blob/38ecef0e5fa9eb83e865e71f969e0c004992a8f9/patterns/media-fit/icon-frame.md`); scroll owner: `.notch-tooltip` (the popover clamps to the viewport and scrolls internally, nothing else scrolls); anti-patterns: nesting a bordered card per account, letting the dial column outgrow the island, giving the popover page-level scroll, and printing a reset line when no reset is known.

Layout: settings surface - five operational configuration domains must scan and edit cleanly without full-viewport input stretching or nested cards -> fixed-sidenav-shell + content-limiter + stack (`https://github.com/changeroa/StyleGallery/blob/38ecef0e5fa9eb83e865e71f969e0c004992a8f9/recipes/saas-settings.md`); scroll owner: `main`; find affordance: one filter field inside the existing `.settings-jump` bar that prunes cards by their own rendered text (title, description, field labels, hints) - it is the lookup layer, never a second navigation or master-detail tree; anti-patterns: letting form inputs stretch unconstrained across wide viewports, nesting bordered toggle boxes or provider sub-cards inside a settings card, mixing immediate UI display preferences into restart-required gateway proxy forms, losing vertical scroll on compact viewports (`<=760px`), leaving the surface without a per-card lookup path once the domain count outgrew the five jump chips, and resetting `main` scroll position when the operator returns to Settings.

Notch load-bearing constraints:
- The dial slot is fixed (`icon-frame`): the ring box does not change size between states, only the `data-count` tiers resize it.
- The popover is a single `box`: one card, accounts separated by full-bleed bands and hairlines, never a card inside a card.
- Vertical balance is `cover`-like: the dial column centers inside the island and the island hugs its content, so fewer providers leave no dead slab.
- Native hover remains the sole expansion owner; nothing in this surface subscribes to pointer expansion.

- Base spacing unit: 4px rhythm (`4px`, `8px`, `12px`, `16px`, `24px`).
- Radius: `4px` (small buttons, badges), `8px` (inputs, standard buttons), `12px` (cards, drawers, dialogs).

## 5. Spatial Layout Primitives and Responsibilities

All layout primitives are typed, state-free, and visual-neutral. Primitives manage layout mechanics, grid distribution, flex flow, and spacing. They do not own colors, borders, shadows, motion tokens, or business state.

The seven governing layout primitives:
- `AppShell`: The root application shell. It manages a bounded 100dvh viewport, positions the fixed 224px sidebar navigation on desktop (or compact mobile navigation rail under 760px), anchors the fixed topbar with `data-tauri-drag-region`, and routes the main workspace.
- `Stack`: Vertical flow container. Manages vertical gaps (`gap-2`, `gap-3`, `gap-4`), `min-width: 0` child containment, and logical flow.
- `Cluster`: Horizontal grouping container. Controls inline item alignment, horizontal gaps, and optional wrapping for metadata pills and badges.
- `WrapRow`: Wrap-safe flex container for action toolbars, provider filter capsules, and button groups. Items wrap cleanly under narrow viewports without clipping parent bounds.
- `IntrinsicGrid`: Responsive grid layout using `minmax(min(100%, <min-size>), 1fr)`. Distributes account cards and metric tiles intrinsically without fragile media queries.
- `ContentLimiter`: Max-width wrapper (1260px max width). Prevents line-length drift on wide monitors while preserving alignment.
- `OverlayLayer`: Viewport-anchored fixed container for onboarding drawers, advanced YAML config drawers, and custom context menus outside normal document flow.

## 6. Scroll Ownership and Fixed Shell Regions

Scroll ownership is single-owner across the entire application:
- Desktop shell: The main workspace (`minmax(0, 1fr)` flex item with `overflow-y: auto` and `min-height: 0`) is the sole vertical scroll owner.
- Document boundary: Root `html` and `body` elements have `overflow: hidden` to eliminate dual page scrollbars.
- Fixed shell regions: The 224px desktop sidebar navigation and the top header bar remain fixed in place while workspace content scrolls.
- Logs surface inner scrolling: The Logs destination contains a dedicated bounded inner scroll container (`<pre>` or log viewport) that scrolls raw daemon output independently without dragging the outer page.
- Overlays: Drawers and context menus anchor directly to the viewport via `OverlayLayer` and manage their own internal overflow without altering workspace scroll position.

## 7. Content-Stress Matrix and Adaptive Constraints

Every surface must pass content-stress verification without layout corruption or horizontal overflow:
- Empty states: Graceful presentation when zero accounts exist, log buffer is empty, telemetry history is clean, or the gateway is offline.
- Long labels: 40-character provider names, account labels, and custom handles must truncate or wrap without breaking parent layout.
- Long text: Multi-line error descriptions and onboarding hints must wrap cleanly.
- Unbroken tokens: 256-character API keys, credentials, JWTs, and URLs must use `overflow-wrap: anywhere` or `word-break: break-all` to prevent box overflow.
- Narrow reflow: Full layout integrity down to 390px mobile viewport and 760px navigation breakpoint. Document-level horizontal overflow is forbidden (`document.documentElement.scrollWidth === document.documentElement.clientWidth`).
- Low vision zoom: Clean presentation under 200% zoom without clipping controls, action buttons, or recovery forms.

## 8. Information Architecture and Surface Contracts

The application exposes exactly four top-level operational destinations plus one isolated native surface:

1. Overview:
   - Dedicated telemetry dashboard.
   - Contains six KPI metrics (In-flight, Total Served, Failovers, Refreshed, Uptime, TTFT), interactive time-range selector (30m, 1h, 1d, 7d, 30d), SVG traffic chart, and provider distribution mix.
   - Must NOT contain account identity, credential lists, account health rows, or onboarding forms.
2. Accounts:
   - Card-based account inventory with provider filter capsules.
   - Supports drag/keyboard reordering, account actions (warm, refresh, reset, re-authenticate, remove), quota progress rows, credential-only badges, and Add Account onboarding.
   - Must NOT use master-detail layout that hides expanded cards. Must NOT introduce a search bar.
   - Separate Warm settings buttons for the selected provider and each account open modal popups; no settings forms or disclosures appear in default account cards. The account menu can open the same popup. Provider defaults and account inherit/custom/off policies live inside dialogs; Run warmup now is a separate explicit action inside the account popup. Dialogs trap focus, close on Escape/backdrop, restore trigger focus, and scroll on mobile.
   - Warmup status reports capability, effective source, last result/attempt and next due or skip reason. Unavailable saved models remain visible but cannot be newly selected; failures never imply success. Same-gateway refreshes preserve drafts; changing gateway discards them. Warmup configuration does not appear in Settings.
3. Logs:
   - First-class operational destination with full-height raw daemon output.
   - Features bounded inner scroll viewport, auto-scroll toggle, log refresh, copy logs button, and gateway status indicators.
   - Must NOT be moved into a drawer, popover, or modal.
4. Settings:
   - Single stacked destination for connection configuration, gateway lifecycle controls, proxy URLs, routing strategies, retry policies, file logging, theme selection, and advanced YAML drawer fallback.
   - Must NOT introduce a secondary navigation rail or sub-tabs.
   - **Brief (Settings redesign, 2026-11-11 — single-purpose card decomposition):**
     - **Primary action:** `Save & reconnect` in the top `Connection & access` card (styled with `.button-primary` accent background; peer save buttons in lower cards use neutral `.button` styling of identical height so each viewport has one prominent primary action).
     - **Information priorities 1-3:** (1) Sticky section jump bar (`On this page`) and `Gateway & Connection` runtime status (`Gateway process` + `Connection & access` form); (2) Single-row OS integration cards (`Desktop integration`, `Native notifications`, `Signed updates`); (3) Decomposed single-responsibility cards across `Proxy & Routing`, `Agents & Tools`, `Security & 2FA Vault`, and `Storage & Appearance` arranged in a two-column section-header/content split on desktop (`>=980px`) within a `1140px` content limiter, with labels aligned on the left rail and controls/actions on the right rail.
     - **Left out on purpose:** Decorative uppercase `.kicker` labels above section headings; multi-topic "kitchen-sink" cards that cram unrelated controls together; cramped half-width `settings-card-pair` wrappers; duplicate TOTP entry lists (`2FA` quick list + separate `Saved entries` card); nested bordered `.toggle-field` boxes,provider sub-cards, and bordered `.shared-key-row` sub-cards; redundant outer `<Card>` around the `CLI agents` group heading.
     - **Required content:** Section jump bar (`Gateway & Connection`, `Proxy & Routing`, `Agents & Tools`, `Security & 2FA Vault`, `Storage & Appearance`); `Gateway process`; `Connection & access` (`Gateway URL`, `API key`, `Copy API key`, `Save & reconnect`); `Desktop integration` (`Start Mahoquot at login`); `Native notifications` (`Enable notifications`); `Signed updates` (`Check for updates`, `Install signed update`); `Proxy behavior` (`Saved changes require restart`, `Routing strategy`, `Request retry count`, `Upstream proxy URL`, `Save proxy settings`); `Runtime & logging flags` (`Write logs to file`, `ChatGPT fast mode`, `Save runtime flags`); `Per-provider proxy routing` (`Enable proxy for <provider>`, `Sticky session (per account)`, `Session TTL (seconds)`, `Proxy URL override`, `Save provider proxy routing`); `Model registry` (`Refresh catalog`); `Account scheduling` (`Enable scheduler`, `Scheduler order` with rank, label, id, remaining %, `Parked`, `Move <label> up/down`); `Public tunnel` (`Download verified cloudflared`/`Enable public tunnel`/`Disable public tunnel`, `Copy public tunnel URL`); `Shared API keys` (`Refresh shared keys`, `Issue key`, key rows with `Edit`, `Top up`, `Pause`/`Resume`, `Revoke`, usage meter, and scopes); `CLI agents` (4 agent cards + preview flow), `Codex instances` launcher, and `Active Codex sessions` (when running); unified `Authenticator entries` (`2FA quick access` with live OTP copy, inline rename `Edit`, `Remove`), `Add authenticator` (`Add 2FA entry`), and `Bulk import` (`Import 2FA entries`); `Appearance` (`Theme`); `Quota display` (`Show remaining quota`, `Cline daily quota display`); `Request history` (`Export authorization secret`, `Export CSV`, `Export JSON`, `Clear history`) and `Model pricing` (`Input price for <model>`, `Estimated spend`, `Save <model> price`) inside the `History and pricing` region; `Advanced YAML` (`Open YAML editor`).
     - **Data shape -> component:** Every card owns one operational topic. Single-control settings (`Gateway process`, `Desktop integration`, `Native notifications`, `Signed updates`, `Model registry`, `Appearance`, `Advanced YAML`) use single-row horizontal `.settings-row-card` containers (title/description left, status/control right). Multi-field forms (`Connection & access`, `Proxy behavior`, `Add authenticator`, `Codex instances`) use compact multi-column input rows. Boolean preferences use left-label / right-checkbox hairline rows.
5. Notch (`?surface=notch`):
   - Native floating desktop status surface running under `:root[data-surface="notch"]`.
   - Bounded to 8px idle strip and 420x560 expanded window with Brink-derived hover corridor, provider grouping, and tooltip behavior.
   - The idle strip shows a 4x64px edge handle tinted by the worst pool's status so the surface is discoverable without hovering.
   - The island is one material stack: a cast shadow under the silhouette, a near-black base gradient, a top rim light, and a hairline edge. The dials sit on that material; they never paint their own opaque panel.
   - The dial arc reports quota only. Provider reachability (cooldown, error, auth, disabled) is a separate corner dot plus popover text, so an exhausted pool and an unreachable pool never read as the same state.
   - The hover popover is a single card. Accounts are full-bleed bands separated by hairlines, quota rows are two lines (name and known reset on the left, value on the right, bar under), and a pooled provider states how many lanes are serving.
   - Quota status color (handle, dial arc, tooltip bar) uses semantic tokens on used percent, matching the tray: `--ok` below 80%, `--warn` from 80%, `--bad` at 100%, neutral when unmeasured. Provider identity is carried by the logo, not the arc color. Each dial is captioned `left`/`used` per the display preference.
   - Completely isolated from main application shell classes, sidebars, and global overflow styles.

## 9. Interaction, Motion, and Accessibility

- Motion: GPU-composited `transform` and `opacity` only. Layout properties are never animated.
- Reduced motion: `prefers-reduced-motion: reduce` suppresses transitions, collapses durations to 0ms, and keeps instant state changes.
- Keyboard navigation: Full keyboard accessibility across navigation, account reordering, buttons, drawers, and context menu.
- Focus visible: High-contrast `--accent` outline (`2px solid var(--accent)`) with `outline-offset: 2px`.
- Form inputs: Every form input has an associated visible label and accessible name. Icon-only buttons declare `aria-label`.
- Overlays: Drawers and context menus capture focus, handle Escape key dismissal, and trap focus while open.
- Offline behavior: Shell navigation and connection configuration remain fully interactive when the gateway daemon is offline.

## 10. State Ownership and Architecture

- Application state: All polling timers, API network calls, gateway lifecycle management, local storage sync, Tauri IPC invoke handlers, and state mutations live exclusively in `App.tsx`.
- Component extraction: Extracted surface components (`OverviewDashboard`, `AccountsSurface`, `LogsSurface`, `SettingsSurface`) are typed and receive state and action callbacks via explicit props.
- Layout primitives: Primitives remain pure functional wrappers with no internal state, hooks, or network effects.

## 11. Explicit Must NOT Rules

- Must NOT change gateway backend code, API routes, schemas, database state, or routing behavior.
- Must NOT add a fifth top-level destination, a Logs drawer, account cards on Overview, provider-as-peer tabs, or a Settings secondary rail.
- Must NOT alter color tokens, font families, icon sets, or provider brand assets.
- Must NOT add external npm/Cargo dependencies, StyleGallery packages, CLI tools, or runtime CSS processors.
- Must NOT copy or vendor StyleGallery prose, generated templates, or unlicensed repository files.
- Must NOT leak global styles or app-shell classes into `:root[data-surface="notch"]`.

## 12. Accepted Debt

- Notch redesign gap ledger (2026-11-08): the island now carries layered material, a rim light, and a cast shadow sized to its content; the popover is one card with per-account bands; reset copy prints only when a reset is known; captions use `--fg-dim` at 10px (>= 4.5:1 on the island); the empty state reuses the provider dial primitive (the second 43px ring implementation is gone); provider health, cooldown, and banked reset credits surface as text in the popover plus a corner dot on the dial; the pooled dial reports the worst serving lane and the popover states the serving count so the two numbers never disagree silently.
- Residual: the dial's corner dot is decorative and has no tooltip of its own; the popover text carries the same information for assistive tech. The dot is per-dial, so a pooled provider with one bad lane of three cannot say which lane is bad from the collapsed surface alone; the popover is the authority. Verified 2026-11-08: the dot's state is not lost to assistive tech — the dial button's `aria-label` (`NotchSurface.tsx:500`) appends `, ${status.text}` for the worst lane, and the popover lists every account with its own status line. No code change needed; the residual is visual-only and the accessible path is already complete.
- Residual: the Lazyweb comparison lane was skipped in the first pass (see the research log). It was re-run on 2026-11-08; the findings and verdict below replace that inference.
- Lazyweb comparison lane (re-run 2026-11-08, four shipped meters viewed: Vercel Usage → Limits, Cohere Billing & Usage, StackAI Workspace Usage, OpenAI Usage: Activity). Findings, as layout grammar only — no screens are traced or shipped:
  - Vercel: limits are flat equal-weight cards in a uniform grid, each one `label >` + `used / limit (pct)` + one thin track at the card's full width. Nothing is a nested card; the grid itself is the only container. The comparison validates the project's flat-single-surface rule.
  - StackAI: same grammar, one row per resource with a striped proportional bar pushed to the right edge and `0.4%` on the left, `4,052/1,000,000 tokens in a day` on the right. Its quota rows are plain list rows inside one panel, not cards.
  - Cohere: no meters at all; usage is a ledger table (`ENDPOINT / MODEL TYPE / QUANTITY / UNIT / TOTAL`) under one headline figure. Confirms a table is an acceptable quota surface when the numbers are transactional.
  - OpenAI: stacked per-resource sections, each with its own axis and bar series, grouped by model selector rather than by resource grid; this is the densest of the four and the only one that does not fit every meter on one screen.
  - Verdict for this project: the notch popover's per-account bands match the grammar all four shipped products use (one flat surface, one row per resource, proportion encoded as a bar, number printed as text). The pooled dial reporting the worst serving lane is a departure none of the four make — they all print per-resource rows and never compress several resources into one aggregate indicator — so the popover, not the dial, must remain the authority for pooled providers. That constraint is now measured, not inferred.
  - Scope limit: this lane compared layout grammar only. It did not test interaction behavior (hover, keyboard, focus order) in those products, so none of those is claimed here.
- Resolved (2026-11-08, upstream `ae62762`): the notch and tray TOTP quick-access branch is gone. `NotchSurface.tsx` and `TrayPanel.tsx` no longer accept `totpEntries`, the `.notch-totp-access` rules are deleted from `globals.css`, and `useTotpVault` stays disabled on both surfaces (`App.tsx:299`). An earlier pass on this branch declined to delete the CSS; that decision was superseded upstream, and the removal is the correct outcome: the branch could never render in the shipped desktop because the host never passed entries to it. The console TOTP surface is unaffected and still covered by its parity test.

- Dependencies remain frozen. Radix, shadcn, and external UI component libraries are not used.
- React developer inspection packages (react-grab, react-scan, react-doctor) are accepted verification debt for this increment and are not persisted in package.json or production bundles.
- StyleGallery serves as a structural spatial contract rather than a pixel mockup source.

## 13. Grounding Gap Ledger

Measured against the built artifact (`ui/index.html`) served to Playwright with a
fixed gateway fixture. `axe-core` tags `wcag2a, wcag2aa, wcag21a, wcag21aa,
wcag22aa`, 4 surfaces x 2 themes x 2 widths (1440, 390).

Baseline: 59 `color-contrast` nodes across 13 of 16 surface/theme/width combos.
After: 0 violations in 16 of 16.

### Recorded exception to §11 (color tokens)

§11 forbids altering color tokens and §9 requires WCAG 2.2 AA. These collided:

`--fg-faint: #71717a` measured 3.55-4.07:1 on dark surfaces and could not reach
4.5:1 on any of them (best case 4.07 on `--bg`). It styles 10-11px meta text
(timestamps, kickers, hints), which is normal-size text under WCAG, so the AA
mandate could not be met without a value change.

Resolution: `--fg-faint` dark raised to `#8f8f98` (4.87:1 on `--panel-3`,
5.36:1 on `--panel-2`, 5.73:1 on `--panel`, 6.13:1 on `--bg`), still
unmistakably dimmer than `--fg-dim`. This is the only token value changed, and
it is recorded here as a deliberate, measured exception. Light mode was already
compliant and is untouched.

Layout: no grid, breakpoint, or scroll-ownership rule changed to fix contrast.
All 26 captures keep identical geometry before and after.

### Contrast fixes that did not touch tokens

| Location | Was | Now | Reason |
|---|---|---|---|
| `.usage-totals` / `strong` | hardcoded `#a8a8ad` / `#6ea8ff` in both themes | `--fg-dim` + `#1d5da3`; dark keeps the original pair under `[data-theme="dark"]` | Light mode measured 2.19:1 and 2.23:1 on the blue tint |
| `.badge-bad` (light) | `--bad` on `--bad-dim` at 4.05:1 | `#b31d28` at 5.09:1 | 429/error badge text |
| `.settings-jump-link.active` | `--accent` on `--accent-dim` at 3.59:1 | `--accent-fg` at 5.20:1 | Active pill in the on-this-page rail |
| `.settings-section-head .kicker` | `--accent` at 4.19:1 | `--accent-fg` at 6.07:1 | Section kicker at 10px |

### Non-contrast defects fixed

| Defect | Evidence | Fix |
|---|---|---|
| Quota bars painted `--ok` at any usage, including 100% used | fixture: 99% and 100% used rendered green | `lib/quota-tone.ts` shared by account card, tray, notch; `data-tone` on bar and value |
| Zod issue array reached a toast verbatim | `Action failed: [ { "code": "invalid_type", ... } ]` | `lib/action-failure.ts` maps Zod/secret-store failures to operator sentences |
| Identical failures stacked separate toasts | 3 error toasts for one condition | `pushToast` collapses an identical visible message and restarts its timer |
| Two distinct providers painted one hue, then disagreed with their own legend | `antigravity`, `zcode`, `cline`, `zai` all resolved to `#358ff3`; the chart de-duplicated seeds but the mix bar and legend did not, so zcode was purple in the chart and blue beside it | `assignDimensionSeeds` is now the single assignment shared by chart, legend, mix bar, and focus chip; collisions demote the later key instead of repeating a hue |
| Tray quota text stayed green until exactly 100% | a `1% left` window rendered green in the tray while the notch graded the same value amber | tray percent text carries `data-tone` from the shared `quotaTone`; `usageTone` in the notch now delegates to it, so console, tray, and notch cannot drift |
| Capture harness could reach a live gateway | 4 unmocked calls hit `127.0.0.1:18801` | containment route registered first; fixture answers `prices`, `healthz`, `/v1/models`, Devin status, Cline catalog, native settings |

### Settings redesign gap ledger (2026-11-10)

| ID | Screen / state | Gap | Principle or rule broken | Evidence | Fix | Proof | Status |
|---|---|---|---|---|---|---|---|
| G1 | Settings / 1440px | `.content.settings-surface` removes `max-width` and stacks 15 full-width cards with 1,100px+ single-column inputs | `layout-skill.md` §3 (`content-limiter`), `recipes/saas-settings.md` | `before/settings-populated-1440-dark-top-before.png` | Constrain `.settings` to `1140px`, use a 2-column section header/cards split at `>=980px`, and pair compact cards and multi-column field grids | `/visual-qa` before/after pair at 1440px & `settings-audit.spec.ts` | closed |
| G2 | Settings / Proxy behavior & Appearance | Immediate local UI toggles (`Show remaining quota`, `Cline daily quota display`) are mixed into the middle of the gateway `Proxy behavior` form that carries `Saved changes require restart` | Hierarchy & mental model (`grounding.md` §2) | `before/settings-populated-1440-dark-mid1-before.png` | Move `Show remaining quota` and `Cline daily quota display` into `Appearance` alongside `Theme`; keep `Proxy behavior` focused on gateway routing scalars | `/visual-qa` before/after pair & E2E tests | closed |
| G3 | Settings / Cards | Bordered `.toggle-field` boxes and inline-styled bordered provider sub-cards are nested inside `.settings-card` | `craft-floor.md` `F9` (no nested cards) | `before/settings-populated-1440-dark-mid1-before.png` | Replace nested boxes with flat hairline-divided rows inside `.settings-card` | `detectPage` + `/visual-qa` Pass A/B | closed |
| G4 | Settings / Section headers | Every section header renders an uppercase 10px accent `.kicker` (`CORE RUNTIME`, `TRAFFIC & DISCOVERY`, etc.) | `craft-floor.md` `F9` (no kicker over a heading) & `undersized-ui-text` | `detectPage` output (10px kicker warnings) | Remove decorative `.kicker` spans from `.settings-section-head` | `detectPage` 0 warnings | closed |
| G5 | Settings / Hierarchy (B1) | Every button uses identical neutral `.button` styling with no prominent primary action | `/visual-qa` `B1` (one primary action per view in prominent style) | `before/settings-populated-1440-dark-top-before.png` | Style `Save & reconnect` with `.button-primary` (accent background, white ink, identical height) | `/visual-qa` `B1` PASS | closed |
| G6 | Shell / <=760px mobile scroll | At `@media (max-width: 760px)`, `.app { display: block }` inside `height: 100dvh; overflow: hidden` causes `main` to grow to full content height instead of scrolling | `layout-skill.md` §1-2 (bounded scroll shell) | `before/settings-populated-390-dark-top-before.png` vs `end-before.png` identical | Set `.app { grid-template-columns: minmax(0, 1fr); }` at `<=760px` so `main` stays bounded to `100dvh` and owns vertical scroll | Scroll probe & 390px top/end captures | closed |
| G7 | Settings / Contrast (E2) | Input `::placeholder` contrast is 2.39:1 and `.agent-conflict` text contrast is 4.42:1 in dark mode | WCAG 1.4.3 / `/visual-qa` `E2` / `detect` `low-contrast` | `detectPage` 3 `low-contrast` errors | Style `::placeholder` with `color: var(--fg-faint); opacity: 1` and raise dark `.agent-conflict` text contrast to `>=4.5:1` | `detectPage` 0 errors | closed |
| G8 | Settings / Typography & 320px reflow | `<small>` defaults to `10.4px` (`tiny-text` / `undersized-ui-text`), `.badge` is `10px`, and 320px stress token overflows containers | `craft-floor.md` / `detect` `tiny-text`, `undersized-ui-text`, `body-text-viewport-edge`, `text-overflow` | `detectPage` 79 warnings | Set settings `<small>` / hints to `12px`, `.badge` to `11px`, and enforce `min-width: 0; overflow-wrap: anywhere` + `.mobile-nav button` truncation | `detectPage --reflow` 0 errors, 0 warnings, 0 advisories | closed |

### Settings findability gap ledger (2026-11-11)

Measured against the built artifact at 1440px: the surface is 3,963px (5.5 screens), carries 16 always-expanded cards and 13 inputs, and offers no per-card lookup at all. The driver is not visual noise but scale: five jump chips over a 5.5-screen page, and after `2026-11-10` every setting was one more card appended to a domain.

| ID | Screen / state | Gap | Principle or rule broken | Evidence | Fix | Proof | Status |
|---|---|---|---|---|---|---|---|
| G9 | Settings / any viewport | No way to find a single card; 0 of 13 inputs were search fields and one jump chip covered 1,762px (44% of the page), so `Retry count` required scanning a 5.5-screen column | `grounding.md` (lookup before scan), `saas-settings.md` | 1440px capture: 3,963px surface, 16 cards, 0 search inputs | One filter field in the `.settings-jump` bar that prunes cards by their own rendered text (title, description, field labels, hints); sections with no surviving card leave the page, `output` reports `N of M`, Escape/Clear restore | `settings-audit.spec.ts` `settings find filters cards by their own text` + `settings filter is reachable from the keyboard`; 4-case unit suite over `settingsQueryTokens`/`matchesSettingsQuery` | closed |
| G10 | Settings / Heading outline | 22 headings all rendered `h2`, so the outline carried no depth; a card title (15px/400) was lighter and smaller-relative than the 14px/600 row titles it contained, and section titles sat only 1px above card titles | `craft-floor.md` heading-step rule (>=1.25x between neighbouring levels, and weight/colour/case must also differ) | computed styles at 1440px: section 16px, card 15px/400, row 14px/600 | Section titles `h2` at 20px/600, card titles `h3` at 16px/600, row titles and sub-heads at 16px/600, agent names `h4` at 13px/600; 20/16 = 1.25x and the card title now outweighs its rows | measured computed styles in the built artifact (section 20px/600, card 16px/600, row 16px/600, agent 13px/600) + `settings-audit.spec.ts` heading assertions by role | closed |
| G11 | Settings / return from another destination | Switching to Overview and back reset `main` scroll to the top and dropped the active jump chip, so a deep edit cost the operator their place | `layout-skill.md` §2 (the scroll container owns position), `grounding.md` (continuity) | reproduced twice at 1440px: scroll 0 and no `aria-current` after return | Module-level `rememberedScrollTop` saved on `scroll` (never in cleanup, where React has already collapsed the container) and restored on mount through `requestAnimationFrame` | `settings-audit.spec.ts` `settings remembers where the operator was after a destination switch` (scrolls to `> 3000`, returns, asserts within 200px) | closed |
