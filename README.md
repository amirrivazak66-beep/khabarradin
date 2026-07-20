# KHABAR RADIN — Project Foundation

Persian (RTL) digital news platform. This repository currently
contains the **foundation only**: design tokens, the CSS architecture,
the JS module system, and a structural header/section scaffold.
No page content has been written yet — that is intentional.

## Stack

Vanilla HTML5 / CSS3 / ES6+. No build step, no framework, no CDN
component libraries (Bootstrap/Tailwind/jQuery/React/Vue).

## Structure

```
/
├── index.html                 Foundation shell (header structure + empty section scaffolds)
├── assets/
│   ├── css/
│   │   ├── reset.css          Browser normalization
│   │   ├── variables.css      Design tokens (color, spacing, radius, shadow, breakpoints, z-index)
│   │   ├── typography.css     Vazirmatn Variable font + type scale
│   │   ├── layout.css         Container, 12-col grid, section rhythm, flex/spacing utilities
│   │   ├── components.css     Buttons, cards, badges, inputs, glass panel, skeleton
│   │   ├── header.css         Header structure (topbar + main bar)
│   │   ├── hero.css           Hero / lead slider scaffolding
│   │   ├── market.css         Market ticker + market card
│   │   ├── news.css           News / Video / Analysis / Feature card specializations
│   │   ├── footer.css         Footer structure
│   │   ├── animation.css      Keyframes + scroll-reveal utilities
│   │   ├── responsive.css     Breakpoints: 1920/1600/1440/1280/1024/768/576/390
│   │   └── style.css          Master import (link ONLY this file from HTML)
│   ├── js/
│   │   ├── app.js             Bootstraps all modules on DOMContentLoaded
│   │   ├── api.js             Fetch wrapper + endpoint registry (only module allowed to call fetch)
│   │   ├── slider.js          Hero slider (autoplay, dots, arrows, swipe, keyboard)
│   │   ├── search.js          Debounced header search + results dropdown
│   │   ├── market.js          Market ticker/card rendering, polling-ready
│   │   ├── theme.js           Dark mode toggle, persisted + OS-aware
│   │   └── animation.js       IntersectionObserver scroll-reveal orchestration
│   ├── images/                Editorial imagery (see README inside)
│   ├── icons/                 favicon.svg + future icon assets
│   └── fonts/                 Self-hosted Vazirmatn Variable font (see README inside)
```

## Design tokens

All tokens are CSS custom properties defined once in
`assets/css/variables.css`. Never hardcode a color, spacing value,
radius, or shadow anywhere else — reference the variable.

| Token group | Values |
|---|---|
| Color | Primary `#0A4FAF`, Dark `#062A63`, Gold `#D4AF37`, Background `#F7F9FC`, Surface `#FFFFFF`, Border `#E6ECF4`, Success `#11B981`, Danger `#EF4444`, Text `#17212F`, Secondary Text `#667085` |
| Spacing | 4 · 8 · 12 · 16 · 20 · 24 · 32 · 40 · 48 · 64 · 80 · 96 |
| Radius | 8 · 12 · 16 · 20 · 24 · 999 |
| Shadows | sm · md · lg · hover |
| Grid | Container 1440px · Content 1280px · 12 columns |
| Breakpoints | 1920 · 1600 · 1440 · 1280 · 1024 · 768 · 576 · 390 |

Dark mode overrides the same variable names under
`[data-theme="dark"]` — components never need dark-mode-specific
selectors themselves.

## Component system

- **Buttons**: `.btn` + `.btn--primary / --secondary / --outline / --ghost / --danger / --gold / --icon`
- **Cards**: `.card` (base) → `.news-card`, `.video-card`, `.analysis-card`, `.feature-card`, `.market-card`
- **Badges**: `.badge` + `--primary / --gold / --success / --danger / --live`

## JS module contract

Every feature module (`theme.js`, `slider.js`, `search.js`,
`market.js`, `animation.js`) attaches itself to `window` and exposes
an `init()` method. `app.js` is the only file that decides *when*
modules initialize — it never contains feature logic itself. Modules
never call `fetch` directly; all network access goes through
`api.js`.

## Accessibility & performance baseline

- Semantic landmarks (`header`, `nav`, `main`, `footer`), ARIA labels
  on icon-only controls, a skip link, and visible focus rings are
  built into the foundation — keep them when adding real content.
- `prefers-reduced-motion` is respected globally (`reset.css` +
  `animation.css`).
- No render-blocking framework JS; all scripts are plain `<script>`
  tags loaded in a defined order at the end of `<body>`.
- Self-host the Vazirmatn variable font (see `assets/fonts/README.md`)
  before shipping to production — the Google Fonts `<link>` in
  `index.html` is a development-time fallback only.

## What is intentionally NOT built yet

- Real content for hero/market/news/footer sections
- Backend/API integration (`api.js` endpoints are placeholders)
- Article, category, and search result pages
- Real market data feed
