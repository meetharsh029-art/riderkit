# RiderKit — motorcycle rider PWA (v1, prototype)

Vanilla JS PWA: ride tracking (Leaflet + OpenStreetMap), crash/fall alert, ride log with notes/photos (IndexedDB), service reminders, group-ride **mock**. Units: km, km/h, ₹.

## Run
```bash
cd rider-app
python3 -m http.server 8080
# open http://localhost:8080
```
Geolocation, motion sensors and service workers need **HTTPS** (localhost is exempt). To test on a phone use an HTTPS tunnel, e.g. `cloudflared tunnel --url http://localhost:8080`, or `npx pinggy -l 8080`. Then "Add to Home Screen".

## Tests
```bash
node tests/test.js            # unit tests: distance, GPS filter, crash detector, alert links, maintenance logic
# headless browser check (needs: npm i puppeteer-core, Chrome at /usr/bin/google-chrome, server on :8080)
node tests/e2e.headless.js
```

## Layout
`index.html` UI · `app.js` app logic + IndexedDB · `lib-core.js` pure logic (shared with tests) · `sw.js` offline cache · `manifest.webmanifest` · `vendor/` Leaflet 1.9.4 (bundled) · `icons/`.

Map tiles come from tile.openstreetmap.org (online; viewed tiles are cached at runtime). See `STATUS.md` for what is verified, and `PLAN.md` for roadmap.


## Run (v3)
`node server/server.js` serves the app and the group-ride API on :8080 (no npm install needed). Tests: `node tests/test.js`, `node tests/server.test.js`, `node tests/e2e.group.js` (needs puppeteer-core + Chrome).


## v4
UI redesigned (neon dashboard theme), Home dashboard is the default tab, vehicles + editable service schedules + tyre tracking on the Service tab. Tests: `node tests/test.js`, `node tests/server.test.js`, and with puppeteer-core + Chrome + server on :8080: `node tests/e2e.headless.js`, `node tests/e2e.home.js` (`SHOTS=1` refreshes `screenshots/`), `node tests/e2e.group.js`. Run the server behind a tunnel with `TRUST_PROXY=1 node server/server.js`.
