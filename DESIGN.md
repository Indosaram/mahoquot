# Mahoquot operations console design contract

## 1. Product direction

Mahoquot is a dense local operations console, not a marketing surface. Preserve the existing dark charcoal shell, orange operational accent, compact account cards, and direct status language. New controls must look native to the existing Overview / Accounts / Settings application.

## 2. Tokens

- Canvas: `--bg`; primary surface: `--panel`; inset surface: `--panel-2`; interactive/track surface: `--panel-3`.
- Borders: `--line` for containment and `--line-soft` for internal separators.
- Text: `--fg`, `--fg-dim`, `--fg-faint` in descending emphasis.
- Accent: `--accent` and `--accent-dim` only for selection, focus, primary identity, and meaningful action emphasis.
- Semantic state: `--ok`, `--warn`, `--bad` and their `-dim` counterparts.
- Spacing follows a 4px base rhythm. Existing 7-18px optical values are preserved; new layout gaps use 8, 12, or 16px.
- Radius: 8px controls, 9-10px status panels, 12px cards.

## 3. Typography

- UI/body: the existing system stack in `globals.css`.
- Data and counters use tabular numerals.
- Page titles are 24px; section titles are 15px; labels/kickers are 10px with tracked uppercase styling.
- Copy remains concise and operational. Do not claim persistence, hot reload, authorization success, or provider capability that the backend has not observed.

## 4. Layout and responsive behavior

- Desktop: sticky 224px sidebar and one scrollable main column; content max-width 1260px.
- Mobile under 760px: sidebar becomes the existing three-item navigation rail; settings and account grids collapse to one column.
- The application shell and Settings navigation remain usable when the gateway is offline.
- Controls must not introduce horizontal page overflow at 390px or 1100px.

## 5. Reusable primitives and states

- `Button`: default, hover, focus-visible, disabled, and pending-label states.
- `Card`: contained operational section; internal groups use `--line-soft` separators rather than nested card stacks.
- `Field` + `Input`: label, hint, invalid/error, disabled, and focused states.
- `Badge`: neutral, ok, warn, and bad semantic states.
- `StatePanel`/`notice`: neutral, warning, danger, and success copy.
- `Drawer`: logs, onboarding, and advanced YAML only; routine scalar settings stay inline on Settings.
- `ProviderGlyph`: bundled provider assets only, with generic fallback for unknown providers.

## 6. Feature contracts

- Accounts owns provider onboarding and credential lifecycle.
- Onboarding must expose the real gateway authorization state: started/pending/completed/error. Opening a URL alone is not completion.
- Settings owns connection plus typed proxy, routing, retry, and logging controls. Raw YAML is an advanced fallback, not the only editor.
- Scalar settings load from and save to `/v0/management/*` routes with boundary validation and truthful saved-state copy.
- Offline mode preserves navigation and editable connection fields.

## 7. Accessibility

- Every input has a visible label; every icon-only button has an accessible name.
- Focus-visible uses the accent outline. Semantic meaning is not color-only.
- Reduced-motion preference disables non-essential transitions.
- Touch targets remain usable on mobile; drawers and forms retain logical keyboard order.

## 8. Accepted debt

- The current frontend uses a compact custom primitive layer rather than installed Radix/shadcn packages.
- The current system font stack and Lucide icon set remain unchanged for this compatibility increment.
- Lighthouse and React render tooling are verification debt unless the local environment supports the required stable Chrome integration.
