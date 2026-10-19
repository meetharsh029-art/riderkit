# Design review and pass (SW riderkit-v28)

User feedback: "a lot of things need better design; the Start group ride button on Home doesn't look good; analyse the whole app."

## Method
`tests/shots.design.js` (helper, not a test) screenshots every screen in light and dark at **390 px and 360 px** width (device scale 2, full page, a fresh browser per page so no state leaks): home (empty + demo data), ride, history, service, docs, help, feedback, hazards, weather, fuel, settings/SOS, sign-in, signed-in account, group setup, live group, community gate / join / feed / post / messages / clubs / profile. That is 23 screens x 2 themes x 2 widths = 92 images per pass.
- Before: `screenshots/design-pass/before-<screen>-<theme>-<width>.png`
- After: `screenshots/design-pass/after-<screen>-<theme>-<width>.png`
- Group ride button: `screenshots/design-pass/compare-group-ride-button.png` (before/after, light on top, dark below)
Full-page captures draw the fixed bottom nav at viewport height mid-page; that is a screenshot artefact, not a bug.

## Design system (now explicit, appended to styles.css as "v28 design pass")
| Token | Values |
|---|---|
| Spacing | `--sp1..5` = 4 / 8 / 12 / 16 / 24 |
| Radii | `--rad-c` 12 (inputs) / `--rad-b` 16 (buttons) / `--rad-card` 20 (cards) |
| Shadows | `--sh1` resting card, `--sh2` raised primary action (light and dark variants) |
| Type | 12 caption / 14 secondary / 16 body / 18 emphasis / 22 section / 28 page title / 30-40 hero numerals (unchanged v9 scale) |
| Touch | all buttons and chips >= 44 px, primary/secondary actions >= 52 px, gaps >= 8 px |

## 1. Start group ride button (Home)
Before: a half-width pill squeezed beside the ring (about 100 px wide at 390, stacked and cramped at 360), a thin grey outline in dark mode, no hierarchy beyond "second button".
After:
- The hero card is now ring + milestone text on top, and a full-width action stack below, identical at 390 and 360.
- **Start ride** = primary: 60 px, solid black (light) / lime (dark), raised shadow.
- **Start group ride** = strong secondary: 52 px, full width, 12 px below the primary, 1.5 px outline (black in light; lime outline on a faint lime tint in dark), a 36 px rounded icon chip with the group icon, bold 16 px label, trailing chevron to say "opens a flow". Visible hover/active/focus states.
- Same element id (`#homeGroup`), still the next sibling of `#homeStart`, still `data-go="group"`.

## 2. Findings and fixes across the app
| # | Finding | Where | Fix |
|---|---|---|---|
| 1 | Literal text "null" shown twice on the Post (compose) screen | Community > Post | **Real bug**: `Element.append(null)` writes "null". Added a null-safe `nz()` wrapper for every `box.append(...)` in community.js. Regression test added. |
| 2 | Primary buttons were content-width orphans (Create group, Save, Suggest default schedule, Join, Create club, Save profile...) while others were full width | Group, Service, Settings, Community, Docs | One rule: a primary/ghost/danger button that is the direct child of a card or form fills the width, 8-12 px spacing above. |
| 3 | Help contacts: Call / Edit / x wrapped into a ragged 2-row pile beside the title | Help, Service schedule, Tyres | Rows with actions now stack: text on top, equal-width action row below, icon-only buttons fixed 52 px. |
| 4 | Group header: code wrapped ("RIDE-" / "2358"), 4 buttons in 2 rows | Live group | Code on its own line at 22 px, Alert / Share / Leave in one equal-width row. |
| 5 | Placeholders cut off ("Ride code e.g. R", "Emergency contact number e.g. +91 98") | Group setup, Settings | Shorter placeholders ("Ride code (RIDE-4821)", "Emergency contact number"; the aria-labels keep the examples), ellipsis, 15 px; Join input flexes. Textarea placeholders wrap. |
| 6 | Links used browser default blue/purple, unreadable on dark | Settings (Terms/Privacy), community rules | Light `#1d4ed8`, dark lime `#bef264`. |
| 7 | Checkboxes used the default blue; checkbox rows misaligned with their text | Community join, Hazards, Settings | `accent-color` black / lime; checkbox pinned to the first text line, 12 px gap. |
| 8 | Hazard filter chips uneven height and heavy | Hazards | Pill chips, fixed 44 px, theme-aware border and fill. |
| 9 | Page title icon dropped onto its own line when the title wrapped | Feedback | Title row no-wrap, icon fixed, centred. |
| 10 | Community tab strip clipped "People" with no hint it scrolls | Community | Right-edge fade mask, scroll snap, hidden scrollbar. |
| 11 | Post actions (Like / Comments / Report / Block) wrapped unevenly at 360 | Feed | 8 px gaps, 44 px targets, card padding 16. |
| 12 | Stat numerals wrapped ("13h / 51m") at 360 | Home | `nowrap`, 26 px below 380 px. |
| 13 | Map-cache "Clear" button had body text running inline next to it | Settings | Full-width button, text below. |
| 14 | Section headings (h3) 12 px grey, hard to scan; Theme card used a different heading style | All | 13 px, consistent spacing, Theme label matches. |
| 15 | Mixed radii (14/18/20) and shadows across cards and buttons | All | Three radii, two shadows (tokens above). |

## 3. Reviewed, left as is (and why)
- Bottom nav: 72 px, 5 items, clear active pill and top bar in both themes; contrast passes the existing WCAG audit.
- Ride screen: dial, stat tiles and 76 px Start are already a clear hierarchy.
- Weather / Fuel / Docs / Feedback forms: consistent after the button and spacing rules.
- Empty states: Home has a good one. History, Messages, Fuel, Stops are one plain line of grey text.

## 4. Not done / open (suggestions)
- Richer empty states (icon + one action) for History, Messages and Fuel; these strings are built in JS and in several tests, so left for a later pass.
- Service "Vehicle profile" `<details>` shows a "–" marker that looks like a stray glyph.
- The long explanatory paragraphs (group privacy, map cache, auto-SOS) are accurate but dense; consider collapsing them behind "Learn more".
- Skeleton / spinner loading states and inline error states were not captured (the screenshots use a local server, so loading is instant); review on a slow connection.
- Everything above was verified in headless Chrome only. Not verified on real phones: real-device font rendering, safe-area insets with the bottom nav on notched phones, one-hand reach, Android/iOS WebView differences (`:has()` is used for action rows; needs Chrome 105+/Safari 15.4+), and the lime-on-dark colours on OLED.

## Tests changed
- `e2e.home.js`: group button >= 48 px, full width, shorter than the primary, icon + chevron, 8-16 px gap, light and dark styling, and no horizontal overflow at 360 px.
- `e2e.community.js`: no stray "null" text on the compose screen.
- SW version assertions updated to `riderkit-v28`.
