# Mahoquot Landing Design System Contract

## 0. Research Log

| Research Lane | Execution & Findings | Status / Deliverable |
|---|---|---|
| **StyleGallery Layout Domain** | Fetched catalog and layout pattern specifications via `curl -fsSL https://raw.githubusercontent.com/changeroa/StyleGallery/main/<path>` on 2026-08-30. Selected 7 concrete structural patterns covering viewport shells, inline groupings, content containment, split sidebars, and responsive grid repetition. | Complete: 7 adopted pattern contracts defined below with upstream URLs and restated constraints. |
| **Embedded Visual Reference** | Evaluated existing production visual direction: mastra-derived matte-black aesthetic (`#020202` page, `#0e0e0e` surface, `#1c1c1c` line, `#f0862a` high-energy amber accent, `#f2f2f2` crisp ink). This direction represents the approved visual baseline and supersedes any generic Layer B default templates. | Complete: Existing look preserved with zero intended visual delta; tokens extracted from `@theme`. |
| **Lazyweb / Imagen Skips** | Skipped deliberately: The visual direction, asset roster, and layout composition are already established and user-approved. No net-new art direction or synthetic imagery was required. | Skipped honestly with rationale recorded. |
| **Adversarial & Guardrail Note** | Upstream StyleGallery markdown documents were processed strictly as structural data. No prompt instructions or verbatim sentences were imported into this specification. | Guardrail verified: All spatial problems and anti-patterns restated in original phrasing. |

---

## 1. Design Tokens

Tokens are single-sourced in `site/src/styles/globals.css` within the Tailwind v4 `@theme` block.

### Color Ramps & Theme Values

| Token Name | Computed Value | Role & Semantic Usage Rules |
|---|---|---|
| `--color-page` | `#020202` | Deep black viewport canvas background. Used on root page body and base section containers. |
| `--color-page-raised` | `#0a0a0a` | Slightly elevated canvas background. Used for alternating section rhythm (Console, Architecture) and nested card backgrounds. |
| `--color-surface` | `#0e0e0e` | Default card, table container, and interactive panel background. |
| `--color-surface-raised` | `#161616` | Higher-elevation background for elevated dialogs or nested highlight panels. |
| `--color-surface-hover` | `#1c1c1c` | Hover state background for secondary buttons, interactive nav rows, and tab items. |
| `--color-line` | `#1c1c1c` | Primary structural border token. Applied to section dividers, card perimeters, header borders, and grid seams. |
| `--color-line-strong` | `#2a2a2a` | High-contrast border token. Used on secondary buttons, interactive hover borders, and scrollbar thumbs. |
| `--color-line-soft` | `#151515` | Low-contrast interior divider token. Used for horizontal table row separators and inner list dividers. |
| `--color-ink` | `#f2f2f2` | Maximum-contrast primary foreground text. Used for main headings, active tab text, and primary button labels. |
| `--color-ink-soft` | `#d9d9d9` | High-contrast secondary text. Applied to general body copy and default typography. |
| `--color-ink-muted` | `#8f8f8f` | Medium-contrast descriptive text. Used for subheadings, lead paragraphs, and inactive navigation links. |
| `--color-ink-faint` | `#6b6b6b` | Low-contrast secondary metadata. Used for section eyebrows, table captions, footnote text, and list item descriptions. |
| `--color-ink-ghost` | `#454545` | Structural text and inactive glyphs. Applied to terminal prompts (`$`), table column headers, bullet dots, and index digits. |
| `--color-accent` | `#f0862a` | High-visibility signature orange accent. Used for text keyword highlights, active checkmark icons, best-in-benchmark callouts, and crate tags. |
| `--color-accent-soft` | `#f5a55c` | Secondary warm accent tint for subtle highlights and hover accents. |
| `--color-ok` | `#4ade80` | Success green indicator. Used for copy-confirmation feedback icons and healthy status pings. |
| `--color-bad` | `#f87171` | Warning/error red indicator. Used for degradation alerts and failover status indicators. |
| `--font-sans` | `"Inter", ui-sans-serif, system-ui, -apple-system, sans-serif` | Primary sans-serif font stack for headings, navigation, and body content. |
| `--font-mono` | `"JetBrains Mono", ui-monospace, SFMono-Regular, monospace` | Monospace font stack for command strings, crate names, metrics, and terminal callouts. |
| `--shadow-panel` | `0 24px 60px -24px rgba(0, 0, 0, 0.9)` | Deep diffused elevation shadow used on featured dashboard screenshot cards. |

### Semantic Border & Layer Usage Rules

1. **Section Isolation:** Sections use `border-b border-line` with alternating background fills (`bg-page` vs `bg-page-raised`) to create horizontal cadence without clutter.
2. **Card Boundaries:** Bounded cards and panel groupings use `rounded-2xl border border-line bg-surface`.
3. **Internal Hierarchy:** Card headers and footers use `border-b border-line` or `border-t border-line`. Individual table rows and internal list elements use `border-b border-line-soft` to reduce visual noise.
4. **Interactive Focus & Buttons:** Buttons and interactive pills utilize `border-line-strong` for clear tactile boundaries against dark surfaces.

---

## 2. Spatial Pattern Contracts (StyleGallery Layout Domain)

Seven structural patterns from the StyleGallery Layout domain are adopted for page composition.

### 1. Sticky Header
- **Upstream Citation:** `https://raw.githubusercontent.com/changeroa/StyleGallery/main/patterns/viewport-shell/sticky-header.md`
- **Spatial Problem (Restated):** Pinning the primary navigation banner to the upper edge of the viewport during vertical page scrolling without occluding underlying content flow.
- **Scroll Owner:** Root viewport (`window` / `document.documentElement`). The header component contains zero internal scroll containers.
- **Break Constraints:** Anchored to `top: 0` / `inset-x-0` with `fixed` positioning and high `z-index: 50`. Content below starts with a `pt-16` offset to prevent overlap.
- **Fallback Behavior:** Standard static block positioning at the top of document flow if sticky/fixed positioning fails.
- **Anti-patterns:** Do not introduce internal vertical scrolling within the header. Do not nest arbitrary unrelated action toolbars inside the fixed shell.
- **Adopted By:** `site/src/components/site-header.tsx`

### 2. Split Navigation
- **Upstream Citation:** `https://raw.githubusercontent.com/changeroa/StyleGallery/main/patterns/in-line-grouping/split-nav.md`
- **Spatial Problem (Restated):** Distributing brand identity, central navigation anchors, and secondary action triggers across an inline horizontal row with distinct alignment zones.
- **Scroll Owner:** Parent layout container. Navigation items wrap or collapse on narrower viewports without inducing horizontal overflow.
- **Break Constraints:** Flexbox row with `items-center gap-8`. Secondary actions and links push to the trailing edge via auto margins (`ml-auto` / `justify-between`). Collapses to a mobile disclosure drawer below `lg` (1024px) breakpoint.
- **Fallback Behavior:** Natural flex wrapping where secondary items flow to subsequent lines.
- **Anti-patterns:** Do not force navigation items to maintain fixed horizontal widths that clip on intermediate tablet viewports.
- **Adopted By:** `site/src/components/site-header.tsx`, `site/src/components/site-footer.tsx`

### 3. Media Object (Hero Split)
- **Upstream Citation:** `https://raw.githubusercontent.com/changeroa/StyleGallery/main/patterns/split-sidebar/media-object.md`
- **Spatial Problem (Restated):** Presenting narrative headline and call-to-action text adjacent to a large graphical visual asset while allowing clean vertical stacking on smaller screens.
- **Scroll Owner:** Document body. No internal scroll areas.
- **Break Constraints:** CSS Grid transitioning from single-column on mobile (`grid-cols-1`) to an asymmetric dual-column split (`lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]`) at the `lg` breakpoint. Right visual container maintains `overflow-hidden` with minimum graphic width rules.
- **Fallback Behavior:** Linear vertical stack with copy block stacked directly above the visual preview.
- **Anti-patterns:** Do not lock column widths in fixed pixels that cause text clipping or image overflow on medium viewports.
- **Adopted By:** `site/src/components/sections/hero.tsx`

### 4. Content Limiter
- **Upstream Citation:** `https://raw.githubusercontent.com/changeroa/StyleGallery/main/patterns/containment/content-limiter.md`
- **Spatial Problem (Restated):** Constraining page content measure to a comfortable maximum reading and scanning width centered inside wide monitor viewports.
- **Scroll Owner:** Document window.
- **Break Constraints:** `mx-auto max-w-[1400px] px-6`. Padding ensures content never collides with viewport edges on mobile devices.
- **Fallback Behavior:** Fluid container spanning 100% of viewport width with inline padding.
- **Anti-patterns:** Do not apply disparate max-width caps across different sections; standard 1400px measure must be uniform across all section containers.
- **Adopted By:** `site/src/components/sections/hero.tsx`, `site/src/components/sections/features.tsx`, `site/src/components/sections/console.tsx`, `site/src/components/sections/benchmarks.tsx`, `site/src/components/sections/architecture.tsx`, `site/src/components/sections/install.tsx`, `site/src/components/site-header.tsx`, `site/src/components/site-footer.tsx`

### 5. Tab Strip
- **Upstream Citation:** `https://raw.githubusercontent.com/changeroa/StyleGallery/main/patterns/in-line-grouping/tab-strip.md`
- **Spatial Problem (Restated):** Organizing discrete interactive category triggers along a single horizontal row that connects seamlessly with an associated detail panel below.
- **Scroll Owner:** Container uses `overflow-x-auto` to allow horizontal swipe navigation on narrow viewports while maintaining inline structure.
- **Break Constraints:** `flex gap-1.5 overflow-x-auto pb-px`. Active tab joins visually with panel border via `rounded-t-xl border border-b-0 bg-surface text-ink`.
- **Fallback Behavior:** Horizontally scrollable flex row on mobile, full multi-tab strip on desktop.
- **Anti-patterns:** Do not allow tab strip overflowing text to truncate invisibly or break into misaligned multi-line rows that disconnect from the detail container.
- **Adopted By:** `site/src/components/sections/features.tsx`

### 6. RAM Grid (Repeat-Auto-MinMax)
- **Upstream Citation:** `https://raw.githubusercontent.com/changeroa/StyleGallery/main/patterns/grid-repetition/ram-grid.md`
- **Spatial Problem (Restated):** Distributing repetitive metric and latency readout tiles across equal-width responsive columns without manual breakpoint micromanagement.
- **Scroll Owner:** Parent section container.
- **Break Constraints:** CSS Grid utilizing `grid-cols-2 sm:grid-cols-4` with `gap-px bg-line overflow-hidden rounded-2xl border border-line` creating crisp hairline inner grid lines.
- **Fallback Behavior:** Collapses from 4-column desktop display to 2-column mobile matrix while preserving uniform tile heights.
- **Anti-patterns:** Do not hardcode fixed column pixel widths that push metric tiles offscreen.
- **Adopted By:** `site/src/components/sections/console.tsx`

### 7. Supporting Pane
- **Upstream Citation:** `https://raw.githubusercontent.com/changeroa/StyleGallery/main/patterns/split-sidebar/supporting-pane.md`
- **Spatial Problem (Restated):** Placing secondary diagnostic visual figures alongside primary metric readouts and descriptive copy to provide live supporting evidence.
- **Scroll Owner:** Root page scroll.
- **Break Constraints:** Two-column grid (`lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]`) collapsing to a single-column layout on mobile/tablet viewports (`< 1024px`).
- **Fallback Behavior:** Vertical stack with primary statistics preceding the supporting visual figure.
- **Anti-patterns:** Do not allow the supporting figure to compress the text column below readable line length (minimum 40ch).
- **Adopted By:** `site/src/components/sections/console.tsx`

---

## 3. Custom Spatial Decisions

Where no upstream StyleGallery pattern applies, bespoke layout contracts are explicitly specified and bounded.

### Provider Marquee: `Marquee:SymmetricCenterStartSeamlessLoop`

* **Context:** Continuous horizontal provider logo ticker located at the bottom of the hero section.
* **Spatial Invariant:**
  - **Entry Offset:** `+50vw` (animation starts with first item entering at viewport center).
  - **Loop Distance:** `-50%` (translation moves left by exactly one duplicate item set width).
  - **Keyframe Formula:** `from { transform: translateX(50vw); } to { transform: translateX(calc(50vw - 50%)); }`.
  - **Seamless Loop Proof:** At `t = duration`, the position of the first element of duplicate set B occupies the exact coordinate that the first element of set A occupied at `t = 0` (coordinate tolerance $\le \pm 0.5\text{px}$).
* **Overflow & Containment:** The outer wrapper container strictly owns overflow (`overflow: hidden`) and applies edge gradient fading via `.mask-fade-edges` (`mask-image: linear-gradient(to right, transparent, black 10%, black 90%, transparent)`).
* **Item Constraints:** Each logo pill is marked with `flex shrink-0 items-center gap-2.5 px-9` ensuring zero width compression during translation.
* **Adopted By:** `site/src/components/sections/hero.tsx`

---

## 4. Typography

Typography is loaded via Google Fonts in `site/index.html` with explicit preconnect hints:
* **Body & Headings:** `Inter` (weights: 300, 400, 500, 600, 700, 800)
* **Code & Metrics:** `JetBrains Mono` (weights: 400, 500, 600, 700)

### Typographic Scale & Application Hierarchy

| Role / Element | Font Family | Size & Line Height Scale | Tracking & Weight | Token / Class String | Call Site Examples |
|---|---|---|---|---|---|
| **Hero Title** | `Inter` | `clamp(2.5rem, 4.6vw, 3.6rem)` / `1.06` | `tracking-[-0.01em]` / 500 | `text-[clamp(2.5rem,4.6vw,3.6rem)] font-medium leading-[1.06] text-ink` | `hero.tsx` |
| **Section Title** | `Inter` | `clamp(1.9rem, 3.2vw, 2.6rem)` / `1.12` | `tracking-[-0.01em]` / 500 | `text-[clamp(1.9rem,3.2vw,2.6rem)] font-medium leading-[1.12] text-ink` | `features.tsx`, `console.tsx`, `benchmarks.tsx`, `architecture.tsx`, `install.tsx` |
| **Panel Heading (Large)** | `Inter` | `22px` / `1.2` | `tracking-[-0.01em]` / 500 | `text-[22px] font-medium text-ink` | `features.tsx` (tab panel title) |
| **Card / Table Title** | `Inter` | `16px` / `1.3` | normal / 500 | `text-[16px] font-medium text-ink` | `benchmarks.tsx`, `architecture.tsx` card headers |
| **Body (Lead)** | `Inter` | `16px` / `1.65` or `1.625` | normal / 400 | `text-[16px] leading-[1.65] text-ink-muted` | `hero.tsx`, section intro paragraphs |
| **Body (Standard)** | `Inter` | `15px` / `1.6` | normal / 400 | `text-[15px] leading-relaxed text-ink-muted` | `features.tsx`, `site-header.tsx` nav links |
| **Secondary & Cell Copy** | `Inter` | `14px` / `1.5` | normal / 400 or 500 | `text-[14px] text-ink-muted` / `text-ink-faint` | `benchmarks.tsx` table cells, `install.tsx` labels |
| **Captions & Metadata** | `Inter` | `13px` / `1.5` | normal / 400 | `text-[13px] leading-relaxed text-ink-faint` | Figure captions, benchmark paeans, footer notices |
| **Eyebrows & Micro Badges** | `Inter` | `12px` / `1.2` | `tracking-[0.12em]` uppercase / 500 | `text-[12px] font-medium uppercase tracking-[0.12em] text-ink-faint` | Section pre-headers (`features.tsx`, `console.tsx`, `benchmarks.tsx`, `architecture.tsx`) |
| **Table Column Headers** | `Inter` | `11px` / `1.2` | `tracking-[0.1em]` uppercase / 500 | `text-[11px] uppercase tracking-[0.1em] text-ink-ghost` | Benchmark & Matrix table headings |
| **KPI Metrics** | `Inter` (tnum) | `26px` / `24px` / `17px` | `tracking-[-0.01em]` / 500 | `tnum text-[26px] font-medium text-ink` | `hero.tsx` stats, `console.tsx` measured tiles |
| **Inline Code & Prompts** | `JetBrains Mono` | `13px` / `15px` | normal / 400 | `font-mono text-[13px] text-ink` | `hero.tsx` CLI hint, `install.tsx` command lines |

---

## 5. Motion

* **Compositing Rule:** All motion is strictly restricted to GPU-composited CSS properties (`transform` and `opacity`). Geometry-altering properties (`width`, `height`, `margin`, `padding`, `top`, `left`) are never animated.
* **Provider Marquee:** Runs as a continuous linear animation at `46s linear infinite` (`.animate-marquee`).
* **Hover & Interactive Transitions:** Button and tab interactions use subtle duration transitions (`transition-colors` or `transition-opacity` at standard 150ms-200ms ease).
* **Motion Serves Meaning:** No extraneous decorative floating objects, continuous pulse rings, or intrusive parallax effects are permitted.
* **Reduced Motion Compliance:**
  ```css
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
      animation-duration: 0.01ms !important;
      animation-iteration-count: 1 !important;
      transition-duration: 0.01ms !important;
      scroll-behavior: auto !important;
    }
  }
  ```

---

## 6. Accessibility Constraints

* **Semantic Landmarks:** Full page structure is articulated with standard semantic landmarks: `<header role="banner">`, `<nav aria-label="...">`, `<main>`, `<section id="...">`, `<figure>`, and `<footer>`.
* **DOM Source Order & Tab Navigation:** The DOM structure mirrors visual reading order identically. Interactive navigation jumps, skip targets, and tab controls maintain sequential logical focus order.
* **Focus Visibility:** Interactive elements (buttons, links, copy triggers, tabs) preserve visible focus indicators using theme-aligned outline / ring styling.
* **Contrast Compliance:**
  - Primary text (`--color-ink`: `#f2f2f2`) on canvas (`--color-page`: `#020202`): **18.7:1** (exceeds WCAG AAA standard of 7.0:1).
  - Secondary text (`--color-ink-muted`: `#8f8f8f`) on canvas (`#020202`): **5.5:1** (exceeds WCAG AA standard of 4.5:1).
  - Accent color (`--color-accent`: `#f0862a`) on canvas (`#020202`): **5.2:1** (exceeds WCAG AA standard for graphic objects and large text).
* **390px Viewport No-Horizontal-Overflow Guarantee:** The landing page is engineered to prevent root horizontal scrolling at mobile widths ($390\text{px}$ viewport). All data tables (`benchmarks.tsx`, `architecture.tsx`) are housed within dedicated `overflow-x-auto` wrapper containers.

---

## 7. Reusable Primitives (Planned Extraction)

Three reusable UI primitives are extracted to centralize common component markup without modifying visual presentation:

### 1. `ui/button.tsx`
* **Variants:**
  - `primary`: `rounded-full bg-ink px-5 py-2.5 text-[14px] font-medium text-page transition-opacity hover:opacity-90`
  - `secondary`: `rounded-full border border-line-strong bg-surface px-4 py-1.5 text-[14px] font-medium text-ink transition-colors hover:bg-surface-hover`
  - `outline`: `rounded-full border border-line-strong px-5 py-2.5 text-[14px] font-medium text-ink transition-colors hover:bg-surface`
  - `ghost`: `rounded-lg text-ink-muted transition-colors hover:bg-surface hover:text-ink`
  - `link`: `transition-colors hover:text-ink`
* **Sizes:** `sm` (`px-4 py-1.5 text-[14px]`), `md` (`px-5 py-2.5 text-[14px]`), `lg` (`px-6 py-3 text-[15px]`)
* **Call Sites:** `site-header.tsx` (Get started CTA), `hero.tsx` (GitHub CTA, docs CTA), `install.tsx` (View source CTA, protocol contracts CTA), `site-footer.tsx` (nav links).

### 2. `ui/section-header.tsx`
* **Structure:**
  - `eyebrow`: `text-[12px] font-medium uppercase tracking-[0.12em] text-ink-faint`
  - `title`: `mt-4 text-[clamp(1.9rem,3.2vw,2.6rem)] font-medium leading-[1.12] tracking-[-0.01em] text-ink`
  - `lead`: `mt-4 text-[16px] leading-relaxed text-ink-muted`
* **Call Sites:** `features.tsx`, `console.tsx`, `benchmarks.tsx`, `architecture.tsx`.

### 3. `ui/card.tsx`
* **Structure:**
  - `Card`: `overflow-hidden rounded-2xl border border-line bg-surface`
  - `CardHeader`: `border-b border-line px-6 py-5`
  - `CardTitle`: `text-[16px] font-medium text-ink`
  - `CardDescription`: `mt-1.5 text-[13px] text-ink-faint`
  - `CardContent`: `overflow-x-auto` or `px-6`
* **Call Sites:** `benchmarks.tsx` (benchmark tables), `architecture.tsx` (feature matrix and crate list), `console.tsx` (accounts screenshot card).

---

## 8. Accepted Debt

| Item ID | Description & Context | Justification / Remediation Plan |
|---|---|---|
| *None currently* | Base design contract initialized. | Any downstream Lighthouse audit discrepancies or visual deviations will be recorded here alongside rationale. The primitive showcase fixture (`site/showcase.html`) is built as an unlinked verification page. |

---

## 9. Component Registry & Pattern Mapping

Every component in `site/src/components/**` maps directly to its adopted spatial contracts:

| Component File Path | Primary Architectural Patterns & Contracts | Reusable Primitives Consumed |
|---|---|---|
| `site/src/components/site-header.tsx` | `sticky-header`, `split-nav`, `content-limiter` | `ui/button.tsx` (CTA / links), `github-mark.tsx` |
| `site/src/components/site-footer.tsx` | `split-nav`, `content-limiter` | `ui/button.tsx` (link variant), `github-mark.tsx` |
| `site/src/components/github-mark.tsx` | Vector SVG asset primitive | Embedded brand icon across headers, CTAs, footers |
| `site/src/components/sections/hero.tsx` | `media-object`, `content-limiter`, `Marquee:SymmetricCenterStartSeamlessLoop` | `ui/button.tsx`, `github-mark.tsx` |
| `site/src/components/sections/features.tsx` | `tab-strip`, `content-limiter` | `ui/section-header.tsx` |
| `site/src/components/sections/console.tsx` | `ram-grid`, `supporting-pane`, `content-limiter` | `ui/section-header.tsx`, `ui/card.tsx` |
| `site/src/components/sections/benchmarks.tsx` | `content-limiter`, responsive table wrapper | `ui/section-header.tsx`, `ui/card.tsx` |
| `site/src/components/sections/architecture.tsx` | `content-limiter`, responsive table wrapper | `ui/section-header.tsx`, `ui/card.tsx` |
| `site/src/components/sections/install.tsx` | `content-limiter`, command row stack | `ui/button.tsx`, `github-mark.tsx` |
