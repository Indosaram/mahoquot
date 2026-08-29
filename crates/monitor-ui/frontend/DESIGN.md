# Quotio Operations Console Design System

## 1. Design Philosophy
- **Mode:** Operate. High information density, scanability, precise metrics, tabular numbers, system fonts.
- **Surface:** Embedded inside desktop Tauri shell (1100×720 default window) and browser `/management.html` (desktop and responsive mobile down to 390×844).
- **Aesthetic:** Dark-first studio console with AA light mode. Neutral slate/zinc backgrounds, sharp border contrast, vibrant semantic indicators (ok = green, warn = amber, bad = red, brand = orange #f0801a).
- **Motion:** GPU-composited opacity and transform only. Respects `prefers-reduced-motion: reduce`.

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
| `--fg-faint` | `#71717a` | `#6b7280` | Muted timestamps, hints |
| `--accent` | `#f0801a` | `#d96b0b` | Brand orange, focus ring, active items |
| `--accent-dim` | `rgba(240, 128, 26, 0.15)` | `rgba(217, 107, 11, 0.12)` | Active pill backgrounds |
| `--ok` | `#3fb950` | `#1a7f37` | Healthy, available, 200 responses |
| `--ok-dim` | `rgba(63, 185, 80, 0.15)` | `rgba(26, 127, 55, 0.12)` | Healthy pill background |
| `--warn` | `#d29922` | `#9a6700` | Cooldown, degraded, retry warning |
| `--warn-dim` | `rgba(210, 153, 34, 0.15)` | `rgba(154, 103, 0, 0.12)` | Warning pill background |
| `--bad` | `#f85149` | `#cf222e` | Errors, failed accounts, locked access |
| `--bad-dim` | `rgba(248, 81, 73, 0.15)` | `rgba(207, 34, 46, 0.12)` | Error banner background |

## 3. Typography Scale
- `text-xs`: 11px (line-height: 14px) - badges, meta, hints, timestamps
- `text-sm`: 13px (line-height: 18px) - primary UI, table cells, form inputs, buttons
- `text-base`: 14px (line-height: 20px) - card headers, navigation links
- `text-lg`: 16px (line-height: 22px) - section titles, stat values
- `text-xl`: 18px (line-height: 24px) - view titles, major KPIs
- Font family: `-apple-system, BlinkMacSystemFont, "SF Pro Text", Inter, system-ui, sans-serif`
- Monospace: `ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace` (all metrics, tokens, ttft, auth handles)

## 4. Spacing & Radius
- Base spacing unit: 4px.
- Radius: `4px` (small buttons/badges), `8px` (inputs/buttons), `12px` (cards/drawers).
