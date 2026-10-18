# RiderKit design pass (v10)

Before/after phone screenshots (390x844 @2x, light theme, same demo data): `screenshots/design/before/` and `screenshots/design/after/` (in the working copy, not in the deploy repo). Regenerate with `SHOTDIR=dir node tests/e2e.theme.js` and `SHOTDIR=dir node tests/shots.group.js`.

## What the research says (sources)
- Touch targets: at least 48x48 dp with 8 dp spacing; 7-10 mm physical (Android accessibility help, developer.android.com). Gloves and vibration argue for larger. Driving UIs go further: 76 dp targets, 23 dp gaps (Android "Design for Driving").
- Glanceable: read and understand in about 2 s; primary text large, secondary smaller; brief text; response to a tap within 0.25 s (Google/Android driving design principles).
- Contrast 4.5:1 minimum for text and icons; day mode = dark text on light background for sunlight (same sources). The theme test audits every screen against WCAG AA (0 failures in light).
- Thumb zone: primary actions low on the screen, nothing critical in top corners (one-handed UX guidance). Bottom nav stays; the primary action per screen was moved/enlarged within thumb reach.

## Choices
- Font: **Inter** variable (SIL OFL), latin subset, 48 KB, self-hosted at `fonts/inter.woff2`, precached by the service worker, with a system-font fallback so nothing breaks offline or if it fails to load. Chosen for tall x-height, clear digits (tabular figures for odometer/speed) and good small-size legibility.
- Type scale: 12 caption / 14 secondary / 16 body / 18 emphasis / 22 section / 28 page title / 32-40 numerals. Section headings (h3) are now small caps labels in muted slate, so the figures and actions carry the hierarchy instead of every heading shouting.
- Spacing rhythm 8 / 12 / 16 / 24; cards keep 18 px radius with a soft two-layer shadow instead of heavy borders. One accent (blue #2563eb) for primary actions and active states; red only for danger (Need help, SOS), amber only for warnings.
- Tap targets: buttons 52 px (small ones 48 px), primary actions 68-76 px, inputs 52 px, nav 72 px, checkboxes 22 px inside 48 px rows.

## Per page
- **Home**: bigger numerals (32 px stats, tabular), dial label no longer overflows, Start ride remains the single filled action (72 px); Start group ride secondary outline.
- **Ride (Navigate)**: map reduced to ~26% of height so the speed dial and a 76 px Start/Stop button sit in thumb reach instead of below the fold.
- **Group**: quick messages are a 2-up grid of 56 px buttons, Need help is full-width red, Hold to talk is a dominant 88 px accent button; the Talk card sits right under the map so the map click area is unchanged; toasts use 18 px text. Message log rows 14 px.
- **Weather**: section labels demoted, key temperature larger (36 px), alert card unchanged (amber).
- **Fuel**: summary figures wrap as a flex row with emphasised values; inputs/labels on the new scale.
- **Service/Vehicles**: card header wraps rather than squeezing Edit/Add, selects and fields 52 px with room for the chevron.
- **More sheet, Feedback, Docs, Help, SOS, History**: global scale, spacing, tap-target and label changes apply (labels 14 px/600, summaries 48 px rows).

## Limits
Not reviewed on a real phone in sunlight or on a bike mount; sizes follow guidelines, not field tests. Dark theme gets the type/spacing changes but only light was tuned visually. Inter is bundled (+48 KB). Pages were not restructured (no new navigation model).
