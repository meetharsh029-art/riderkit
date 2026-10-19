# Malhiva — Logo Research & Directions

Context: rider app now (clean white professional UI) → smart helmets / bike devices → own electric bike. Founder Harshmeet Malhi, Punjab, India; global ambitions.
Note: brand observations below are from general design knowledge of these brands (no live scraping); verify current marks before citing them anywhere public.

## 1. What the reference brands teach

| Brand | Mark type | Typography / shape | Colour | Scaling lesson |
|---|---|---|---|---|
| Royal Enfield | Badge/crest + wordmark | Heritage serif/slab, cannon emblem | Black, cream, gold, red | Badge works on tank; too detailed for app icon (they use simplified "RE"/cannon) |
| Ather | Wordmark + abstract "A" | Clean geometric sans, lowercase feel | Lime/green accent on dark/white | Simple mark = good dash, app, scooter side panel |
| Ola Electric | Wordmark/ monogram "O" | Rounded modern sans | Black / white / vivid accent | Very simple circle-ish mark scales anywhere |
| Rivian | Compass-arrow symbol + wordmark | Wide, light-weight sans | Forest/ink + yellow "Adventure" | Single bold geometric symbol is ownable and stencil-able |
| Cake | Minimal wordmark | Lowercase/uppercase sans, thin geometry | White, black, lime/mint | Extreme minimalism = premium, but low ownable-ness |
| Zero Motorcycles | Wordmark | Bold wide sans | Black / white / red | Short word + heavy weight reads on frames |
| Ducati | Shield badge + italic wordmark | Italic, sharp caps | Red, white, black | Red + shield = instant tank badge; italics = speed |
| Harley-Davidson | Bar-and-shield badge | Heavy slab/script | Orange, black | Badge shape is the logo; fine on tanks, heavy on UI |
| Rever | App wordmark/symbol | Rounded modern sans | Dark + orange | Rider-app: simple symbol + route identity |
| Forcite | Wordmark | Clean sans, caps | Black/white | Helmet tech = restrained, near-monochrome decals |
| Strava | Chevron "peak" symbol | Bold custom wordmark | Orange on white | One-colour distinctive glyph; app icon = glyph alone |
| Komoot | Wordmark + simple mark | Friendly sans | Green | Path/nature cues; wordmark carries brand |
| Garmin | Wordmark + diamond/ "delta" | Bold sans caps | Black/blue | Hardware: wordmark engraved/printed at tiny sizes |
| Tesla | Custom T symbol + wide caps wordmark | Extended geometric caps | Red / white / black | Symbol alone on car; wordmark alone on charging |

### Patterns that work
1. **Symbol + wordmark lockup, symbol usable alone.** App icon and helmet decal = symbol; tank/frame badge = symbol or wordmark.
2. **Monogram/letter or abstract glyph in ≤2 colours**, with solid shapes (no gradients, thin hairlines, drop shadows) so it survives embroidery, vinyl, die-cast metal and 29px icons.
3. **Typography**: geometric/grotesque sans (Ather, Rivian, Ola, Zero); caps with wide tracking for premium hardware (Tesla, Rivian); italic/condensed caps for performance (Ducati). Heritage brands (RE, Harley) use badges/serif, a poor fit for a new-tech brand.
4. **Colour**: automotive/moto leans black/white + ONE signal colour (red, orange, lime, yellow). White UI favours one saturated primary with strong contrast. Orange/lime are great accents but fail as text on white.
5. **What scales**: simple silhouette, even stroke weight ≥ ~8% of icon height, 1–2 colours, works inverted and in single colour.
6. **Avoid**: literal helmets/bikes/wheels (generic), speed lines clichés, gradients as identity, fine detail, more than 2 colours, names in script.
7. **Global/India fit**: keep Latin wordmark primary; design the symbol so a Gurmukhi/Hindi lockup (ਮਲਹਿਵਾ / मल्हिवा) can be added later. Pick a colour that isn't tied to a single competitor (Ather lime, Ola black/yellow, RE gold, Ducati red).

## 2. Four directions (all built as SVG in `brand/logos/`)

Contrast on white (WCAG): ≥4.5 OK for text, ≥3 OK for large graphics/UI components.

### A. Pathline M — "the route is the letter" *(app-first)*
- Concept: an M drawn as one continuous rounded road stroke; orange dotted waypoint down the middle = a ride/destination pin.
- Palette: Primary **#1D4ED8** (6.7:1 ✔), accent **#F97316** (2.8:1 – graphic only, never text), ink **#0F172A**, dark-mode primary #6EA2FF (7.4:1 on #0B1220).
- Fonts: **Sora** Bold (wordmark, lowercase) + **Inter** (UI).
- Safe zone: glyph kept in central 80% of tile (10% padding); stroke ≥ 8 units of 100; the orange dot must stay inside the M counter and remains legible ≥ 40px; drop the dot below 32px.
- Do: use blue for CTAs, lowercase wordmark, M alone as app icon/helmet-side decal. Don't: add gradients, use orange for text, add motion lines.
- Weakness: soft/friendly; looks like many fintech/tech apps; less "motorcycle". Blue is the most crowded app colour.

### B. Custom 'iva' Wordmark — "the wordmark is the logo" *(brand-led)*
- Concept: lowercase "malhiva" in Outfit SemiBold; dotless ı with an amber dot (headlight/sun) and "va" in amber with a rider line underneath. Icon = bold "m" with the amber dot.
- Palette: Primary ink **#0F172A** (17.9:1 ✔), accent **#F59E0B** (2.15:1 – graphic only), dark mode text #F8FAFC / accent #FBBF24.
- Fonts: **Outfit** (wordmark) + **Manrope** (UI).
- Safe zone: icon 'm' ~80% of tile, dot kept ≥ 6 units from edge; below 24px drop to plain "m" without dot. Underline line only in wordmark ≥ 120px wide.
- Do: keep "iva" in accent consistently; Don't: put amber text on white; stretch letters; use the underline on small decals.
- Weakness: ordinary letters → weakest ownable symbol; best with a designer to custom-draw 'iva' ligature (v–a joined as a speed chevron).

### C. Visor Badge — "tech helmet / hardware badge" *(hardware-first)*
- Concept: round badge (helmet-visor/dial; works as screen, button, tank medallion) holding a sharp M with a lime visor-glint arc under it.
- Palette: Primary **#0F766E** teal (5.5:1 ✔), accent **#84CC16** lime (2.0:1 – graphic only), ink #0B1F1D; dark mode #2DD4BF (10:1) / #A3E635.
- Fonts: **Space Grotesk** Bold caps tracked wide + **Inter** (UI).
- Safe zone: circle is its own mask — keep ring ≥ 7/100 stroke, ring at 80% of tile; below 32px remove the lime arc and keep ring+M; ring is the natural die-cut/emboss shape on helmet chin or bike tank.
- Do: use the circle for helmet decal/LED ring, power button, tank badge; Don't: add gradient or shadow, fill the ring with picture.
- Weakness: circle+M is common (many badge marks); M inside the ring gets small at 29px.

### D. Apex M — "performance/EV bike" *(bike-first)*
- Concept: italic sharp M (peak/mountain/Punjab-to-Himalaya road ahead) with a small black arrow notch; condensed italic caps wordmark à la Ducati/Rivian energy.
- Palette: Primary **#C8102E** red (5.9:1 ✔), accent/ink **#111827** (17.7:1 ✔), dark mode #FF4D63 (5.8:1 on #0B1220) / #F3F4F6.
- Fonts: **Barlow Condensed** ExtraBold Italic (wordmark) + **Barlow** (UI).
- Safe zone: italic leans out, so keep a 12% margin (we use 10% padding + skew); miter points are sharp — thicken to ≥ 13/100 stroke for embroidery; notch triangle dropped below 40px.
- Do: use as tank badge in chrome/red enamel, helmet side decal in reflective vinyl; Don't: use red as large UI fill in the white app (reserve for brand moments/CTAs), mix with the amber accent from B.
- Weakness: red + italic M reads Ducati/ "motorsport"; a safety app may want calmer trust cues. Check red isn't confusable with error states in the UI (use #C8102E for brand only, separate error red).

## 3. Recommendation

**Top pick: Direction A (Pathline M) refined with Direction D's sharpness — or, ranked on today's reality:**
1. **A — Pathline M** for the app now: it uses the white-theme-friendly blue, has the most meaningful concept (road = M = ride), and the symbol is simple and one-colour friendly. Ask the designer to push it away from "generic tech blue" — e.g. a deeper "road-night" blue (#1E3A8A–#1D4ED8) with the single warm waypoint accent, and a sharper/more custom curve so it can later be a tank badge.
2. **C — Visor Badge** is the best long-term hardware container (helmet/emboss/tank/LED ring) — keep as the *badge frame* for future products around symbol A (A's M inside C's circle).
3. D — strongest for the e-bike era but too aggressive for the app today; revisit at bike stage.
4. B — good wordmark base; use A or C wordmark typography (Sora or Outfit) as secondary.

Suggested system: **Symbol** = Pathline M (A); **Wordmark** = lowercase Sora/Outfit; **Badge** = circle frame (C) for hardware; **Primary** blue #1D4ED8, **accent** warm (orange/amber), **ink** #0F172A, white surfaces.

## 4. Next steps
1. Pick the direction (or A+C hybrid) and test: app icon on a phone home screen at 60/29 px (light + dark wallpaper), helmet-side mock at 3–5 cm, single-colour stamp.
2. Hire a freelance brand/logo designer (budget a few hundred to low thousands USD; ask for vector source, custom M construction, one-colour/reverse versions, Gurmukhi/Hindi lockup, 3 usage rules); share this doc + the SVG mockups as a brief. These SVGs are concepts only — not final art (fonts converted to outlines from open-licence Google Fonts; check licence if reused).
3. Name & trademark: run a clearance search ("Malhiva" similar names) on India IP India public search and WIPO Global Brand DB, then file under classes **9** (software/apps, smart helmets/devices), **12** (vehicles/e-bikes), **42** (SaaS), maybe **25/28** (apparel, gear). Do after final logo, ideally file word mark first (cheap, covers any logo). Consider Madrid Protocol later for global. Use a trademark attorney. (Nothing filed or purchased as part of this task.)
4. Secure domains/handles (malhiva.com, .in, social handles) before public launch.
5. Create a one-page brand kit: colours with hex/RGB/CMYK/Pantone, clear space = height of the M stem, min size (symbol 16px digital / 8mm print), forbidden uses.
6. Export set: SVG, PNG 1024 app-store icon (no transparency, no rounded corners — stores round it), Android adaptive icon (foreground in central 66% safe zone), favicon 32/16, one-colour decal vectors.
7. Check accessibility: don't use the accent colours for text on white; use primary/ink only.

## 5. Files
- Mockups (SVG + PNG): `brand/logos/{a-pathline,b-wordmark-iva,c-visor-badge,d-apex-m}-{wordmark,icon}-{light,dark}.svg/.png`
- Comparison sheet: `brand/logo-directions.png`
- Generator script: `brand/build/gen.py`


## 5. Direction C — Round 2 (face-at-a-glance, M-up-close)

Files: `brand/logos-r2/` (SVG+PNG), comparison sheet `brand/logo-c-round2.png`, generator `brand/build/gen_r2.py`.
**Core concept (user requirement):** at a quick glance the badge reads as a friendly helmet-visor face; on closer look it is clearly the letter M. Construction: the M's two lower counters (the notches under the diagonals) host two small upright "eye" ovals, the M's centre V tip is the nose, and the lime/teal crescent is the smile (C3: a visor-brow arc instead of a smile, eyes only — the most restrained/"tech" read). Eyes are kept small and accent-coloured so the M silhouette stays dominant (see `*-closeup-M.png`: full vs M-only). Face test: `*-glance-test.png` (24px/40px, x3 zoom and blurred squint).
Per variant files: `cN-*-icon-{light,dark}`, `-icon-*-small` (≤32px, thicker, no hairlines), `-wordmark-{light,dark}` (Space Grotesk Bold caps, tracked, outlined), `-mono-icon`, `-mono-wordmark`, `-adaptive-{bg,fg,mono,dark-bg,dark-fg}` (fg glyph scaled to 76% of the 108dp canvas, badge diameter ≈66dp = Android safe zone) + `-adaptive-preview.png` (circle / squircle / square / safe-zone guide), `-size-test.png` (16/32/48/192, light + dark), `-mock-helmet-bike.*` (helmet side decal + die-cast tank badge, concept only).

| # | Variant | Palette | Idea | Contrast (WCAG) |
|---|---|---|---|---|
| C1 | Faceted Ring | teal #0F766E + lime #84CC16 | closest to round 1; ring + M + smile | teal on white 5.47 ✔; lime on white 1.98 (graphic only) |
| C2 | Navy Disc | navy #0B2447 + teal #2DD4BF + white | solid disc, angled-foot M | navy/white 15.5 ✔; teal on navy 8.3 ✔ |
| C3 | Black Horizon | black #0A0A0A + lime + white | visor brow arc over wide M, full-bleed black tile | white on black 19.8 ✔; lime on black 10.0 ✔ |
| C4 | Open Ring | deep teal #115E59 + lime | ring open at bottom, smile closes the gap (road to horizon) | teal on white 7.58 ✔; lime on white 1.98 (graphic only) |
| C5 | Shield Badge | navy #0B2447 + lime + white | shield for bike/tank badge | navy/white 15.5 ✔; lime on navy 7.8 ✔ |

Rules: lime/bright accents are never text and never the only carrier on white — on white (C1, C4) lime appears only as small glints beside a dark teal element; on navy/black they pass 3:1+ easily. Dark-mode: C1/C4 use #2DD4BF/#A3E635 on dark teal (M 9.2 / 7.9 ✔).
Small sizes: the smile and eyes are kept at 16–32px (thicker); at 16px the face reads as "dots + smile" in C2/C5 (solid ground), is weakest in C1/C4 (outline ring). Ring hairline in C3 is dropped ≤32px.
Mono one-colour: C1/C3/C4 use a single ink colour on white; C2/C5 are solid silhouettes with M/eyes/smile knocked out (works for vinyl, embossing, stamp).

**Top recommendation: C2 Navy Disc** (with C5 Shield as the bike/tank-badge sibling). Highest contrast, face reads clearest in a squint/16–24px test because the disc is solid, M stays unmistakable (white on navy), mono/knockout is trivial, and navy+teal gives a calmer, more trustworthy non-lime-primary UI colour while lime stays a graphic spark (use lime on the navy/black grounds, e.g. C5/C3 accents). Runner-up: C4 Open Ring for the most distinctive silhouette. Caveats: faces in logos are close to emoji/"smiley" territory — keep eyes small as drawn; test with 5 people (first word they say at 1 second); run trademark/design-similarity search; concept art only, no filings/purchases made.
