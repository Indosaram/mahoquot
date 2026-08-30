# Mahoquot Operations Console Design Contract

## 0. Pinned Reference and Clean-Room Architecture

This design system governs the spatial retrofit of the Mahoquot desktop console. Layout mechanics are derived from the pinned StyleGallery repository at commit `38ecef0e5fa9eb83e865e71f969e0c004992a8f9`. Because the upstream repository has no root LICENSE, all mechanics are restated in clean-room form. No upstream prose, files, CLI tools, or packages are copied or imported.

Pinned reference links:
- Repository tree: `https://github.com/changeroa/StyleGallery/tree/38ecef0e5fa9eb83e865e71f969e0c004992a8f9`
- Scroll body shell: `https://github.com/changeroa/StyleGallery/blob/38ecef0e5fa9eb83e865e71f969e0c004992a8f9/patterns/viewport-shell/scroll-body-shell.md`
- Fixed side navigation shell: `https://github.com/changeroa/StyleGallery/blob/38ecef0e5fa9eb83e865e71f969e0c004992a8f9/patterns/viewport-shell/fixed-sidenav-shell.md`
- List/detail containment: `https://github.com/changeroa/StyleGallery/blob/38ecef0e5fa9eb83e865e71f969e0c004992a8f9/patterns/split-sidebar/list-detail.md`
- Dashboard recipe: `https://github.com/changeroa/StyleGallery/blob/38ecef0e5fa9eb83e865e71f969e0c004992a8f9/recipes/dashboard.md`
- SaaS settings recipe: `https://github.com/changeroa/StyleGallery/blob/38ecef0e5fa9eb83e865e71f969e0c004992a8f9/recipes/saas-settings.md`
- Motion vocabulary: `https://github.com/changeroa/StyleGallery/blob/38ecef0e5fa9eb83e865e71f969e0c004992a8f9/motion/vocabulary.md`

## 1. Product Direction and Atmosphere

Mahoquot is a dense local operations console, not a marketing surface. The visual signature is a dark-first studio command center with neutral slate/zinc surfaces, crisp borders, and an orange operational accent (`#f0801a`). High scanability, tabular numerals, and truthful status language take precedence over decoration.

Every surface is embedded in either the desktop Tauri shell (1100x720 default window) or browser `/management.html` (desktop and responsive mobile down to 390x844). The native notch surface (`?surface=notch`) runs as an isolated floating window.

## 2. Spatial Layout Primitives and Responsibilities

All layout primitives are typed, state-free, and visual-neutral. Primitives own containment, flex, grid, and spacing geometry. They do not own colors, borders, shadows, motion tokens, or business state.

The seven governing layout primitives:
- `AppShell`: The root application container. It enforces a bounded 100dvh viewport, positions the fixed 224px sidebar navigation on desktop (or compact mobile navigation rail under 760px), anchors the fixed topbar with `data-tauri-drag-region`, and routes the main workspace.
- `Stack`: Vertical flow container. Manages vertical gaps (`gap-2`, `gap-3`, `gap-4`), `min-width: 0` child containment, and logical vertical flow.
- `Cluster`: Horizontal grouping container. Controls inline item alignment, horizontal gaps, and optional wrapping for metadata pills and badges.
- `WrapRow`: Wrap-safe flex container for action toolbars, provider filter capsules, and button groups. Items wrap cleanly under viewport stress without clipping parent bounds.
- `IntrinsicGrid`: Responsive grid layout using `minmax(min(100%, <min-size>), 1fr)`. Distributes account cards and metric tiles intrinsically without fragile media queries.
- `ContentLimiter`: Max-width wrapper (1260px max width). Prevents line-length drift on wide monitors while preserving alignment.
- `OverlayLayer`: Viewport-anchored fixed container for onboarding drawers, advanced YAML config drawers, and custom context menus outside normal document flow.

## 3. Scroll Ownership and Fixed Shell Regions

Scroll ownership is explicit and single-owner across the entire application:
- Desktop shell: The main workspace (`minmax(0, 1fr)` flex item with `overflow-y: auto` and `min-height: 0`) is the sole vertical scroll owner.
- Document boundary: Root `html` and `body` elements have `overflow: hidden` to eliminate dual page scrollbars.
- Fixed shell regions: The 224px desktop sidebar navigation and the top header bar remain fixed in place while workspace content scrolls.
- Logs surface inner scrolling: The Logs destination contains a dedicated bounded inner scroll container (`<pre>` or log viewport) that scrolls raw daemon output independently without dragging the outer page.
- Overlays: Drawers and context menus anchor directly to the viewport via `OverlayLayer` and manage their own internal overflow without altering workspace scroll position.

## 4. Content-Stress Matrix and Adaptive Constraints

Every surface must pass content-stress verification without layout corruption or horizontal overflow:
- Empty states: Graceful presentation when zero accounts exist, log buffer is empty, telemetry history is clean, or the gateway is offline.
- Long labels: 40-character provider names, account labels, and custom handles must truncate or wrap without breaking parent layout.
- Long text: Multi-line error descriptions and onboarding hints must wrap cleanly.
- Unbroken tokens: 256-character API keys, credentials, JWTs, and URLs must use `overflow-wrap: anywhere` or `word-break: break-all` to prevent box overflow.
- Narrow reflow: Full layout integrity down to 390px mobile viewport and 760px navigation breakpoint. Document-level horizontal overflow is forbidden (`document.documentElement.scrollWidth === document.documentElement.clientWidth`).
- Low vision zoom: Clean presentation under 200% zoom without clipping controls, action buttons, or recovery forms.

## 5. Information Architecture and Surface Contracts

The application exposes exactly four top-level operational destinations plus one isolated native surface:

1. Overview:
   - Dedicated telemetry dashboard.
   - Contains six KPI metrics (In-flight, Total Served, Failovers, Refreshed, Uptime, TTFT), interactive time-range selector (30m, 1h, 1d, 7d, 30d), SVG traffic chart, and provider distribution mix.
   - Must NOT contain account identity, credential lists, account health rows, or onboarding forms.
2. Accounts:
   - Card-based account inventory with provider filter capsules.
   - Supports drag/keyboard display reordering, account actions (warm, refresh, reset, re-authenticate, disable/enable, remove), quota progress rows, credential-only badges, and Add Account onboarding.
   - Add Account exposes the complete 83-row production provider catalog. Bespoke OAuth/wire providers retain dedicated flows; API-key and local OpenAI-compatible providers use the shared typed credential form.
   - A disabled credential remains visible in inventory with disabled status, is excluded from the runtime pool, and can be enabled again without re-importing it.
   - Provider onboarding is provider-first: selecting a provider opens its existing account inventory and all repeatable add methods instead of starting authorization immediately.
   - The provider catalog drawer owns a search field because the complete catalog cannot be navigated reliably as one unfiltered 83-item grid; the Accounts destination itself remains search-free.
   - Must NOT use master-detail layout that hides expanded cards. Must NOT introduce a search bar.
3. Logs:
   - First-class operational destination with full-height raw daemon output.
   - Features bounded inner scroll viewport, auto-scroll toggle, log refresh, copy logs button, and gateway status indicators.
   - Must NOT be moved into a drawer, popover, or modal.
4. Settings:
   - Single stacked destination for connection configuration, gateway lifecycle controls, proxy URLs, routing strategies, retry policies, file logging, theme selection, and advanced YAML drawer fallback.
   - Must NOT introduce a secondary navigation rail or sub-tabs.
5. Notch (`?surface=notch`):
   - Native floating desktop status surface running under `:root[data-surface="notch"]`.
   - Bounded to 8px idle strip and 420x480 expanded window with Brink-derived hover corridor, provider grouping, and tooltip behavior.
   - Completely isolated from main application shell classes, sidebars, and global overflow styles.

## 6. Color Tokens and Visual Styling

| Role | Dark Token Value | Light Token Value | Description |
|---|---|---|---|
| `--bg` | `#0b0b0d` | `#f4f4f7` | Canvas background |
| `--panel` | `#141417` | `#ffffff` | Primary cards, sidebar, panel background |
| `--panel-2` | `#1b1b1f` | `#f8f8fa` | Nested panels, table row hover, code blocks |
| `--panel-3` | `#232329` | `#eef0f4` | Inactive toggles, subtle pill background |
| `--line` | `#26262c` | `#dcdcde` | Strong borders, card outlines |
| `--line-soft` | `#1c1c22` | `#eaecef` | Internal group separators, soft dividers |
| `--fg` | `#ececf1` | `#111827` | Primary high-contrast text |
| `--fg-dim` | `#a1a1aa` | `#4b5563` | Secondary text, input labels |
| `--fg-faint` | `#71717a` | `#6b7280` | Muted timestamps, helper hints |
| `--accent` | `#f0801a` | `#d96b0b` | Brand orange, focus ring, active selection |
| `--accent-dim` | `rgba(240, 128, 26, 0.15)` | `rgba(217, 107, 11, 0.12)` | Active pill backgrounds |
| `--ok` | `#3fb950` | `#1a7f37` | Healthy status, available, 200 responses |
| `--ok-dim` | `rgba(63, 185, 80, 0.15)` | `rgba(26, 127, 55, 0.12)` | Healthy pill background |
| `--warn` | `#d29922` | `#9a6700` | Cooldown, degraded state, retry warning |
| `--warn-dim` | `rgba(210, 153, 34, 0.15)` | `rgba(154, 103, 0, 0.12)` | Warning pill background |
| `--bad` | `#f85149` | `#cf222e` | Error state, failed account, locked access |
| `--bad-dim` | `rgba(248, 81, 73, 0.15)` | `rgba(207, 34, 46, 0.12)` | Error banner background |

Typography scale:
- UI body: `-apple-system, BlinkMacSystemFont, "SF Pro Text", Inter, system-ui, sans-serif`
- Code and numbers: `ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace`
- Data metrics, timestamps, and counters use tabular numerals (`font-variant-numeric: tabular-nums`).
- Scale: `text-xs` (11px/14px), `text-sm` (13px/18px), `text-base` (14px/20px), `text-lg` (16px/22px), `text-xl` (18px/24px).
- Spacing rhythm: 4px base unit (`4px`, `8px`, `12px`, `16px`, `24px`).
- Radius: `4px` (small badges), `8px` (controls, buttons, inputs), `12px` (cards, panels, drawers).
- Provider branding: Bundled official SVG provider assets only; Lucide icons for system controls.

## 7. Interaction, Motion, and Accessibility

- Motion: GPU-composited `transform` and `opacity` only. Layout properties are never animated.
- Reduced motion: `prefers-reduced-motion: reduce` suppresses transitions, collapses durations to 0ms, and keeps instant state changes.
- Keyboard navigation: Full keyboard accessibility across navigation, account reordering, buttons, drawers, and context menu.
- Focus visible: High-contrast `--accent` outline (`2px solid var(--accent)`) with `outline-offset: 2px`.
- Form inputs: Every form input has an associated visible label and accessible name. Icon-only buttons declare `aria-label`.
- Overlays: Drawers and context menus capture focus, handle Escape key dismissal, and trap focus while open.
- Offline behavior: Shell navigation and connection configuration remain fully interactive when the gateway daemon is offline.

## 8. State Ownership and Architecture

- Application state: All polling timers, API network calls, gateway lifecycle management, local storage sync, Tauri IPC invoke handlers, and state mutations live exclusively in `App.tsx`.
- Component extraction: Extracted surface components (`OverviewDashboard`, `AccountsSurface`, `LogsSurface`, `SettingsSurface`) are typed and receive state and action callbacks via explicit props.
- Layout primitives: Primitives remain pure functional wrappers with no internal state, hooks, or network effects.

## 9. Explicit Must NOT Rules

- Must NOT change gateway backend code, API routes, schemas, database state, or routing behavior.
- Must NOT add a fifth top-level destination, a Logs drawer, account cards on Overview, provider-as-peer tabs, or a Settings secondary rail.
- Must NOT alter color tokens, font families, icon sets, or provider brand assets.
- Must NOT add external npm/Cargo dependencies, StyleGallery packages, CLI tools, or runtime CSS processors.
- Must NOT copy or vendor StyleGallery prose, generated templates, or unlicensed repository files.
- Must NOT leak global styles or app-shell classes into `:root[data-surface="notch"]`.

## 10. Accepted Debt

- Dependencies remain frozen. Radix, shadcn, and external UI component libraries are not used.
- React developer inspection packages (react-grab, react-scan, react-doctor) are accepted verification debt for this increment and are not persisted in package.json or production bundles.
- StyleGallery serves as a structural spatial contract rather than a pixel mockup source.
