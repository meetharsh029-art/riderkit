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


## v5 stage 1
Weather (Open-Meteo, route rain alerts, destination forecast), fuel/mileage/₹-per-km log + "what was this stop?", full JSON backup/restore (SOS & settings tab), vehicle editing. Tests: `node tests/test.js`, `node tests/stage1.test.js`, `node tests/server.test.js`; with puppeteer-core + Chrome + internet: `tests/run-all.sh 3` (everything, 3 times).

Theme: light by default, dark via the header button (`localStorage rk-theme`). `node tests/e2e.theme.js` audits contrast; `SHOTS=1` writes phone screenshots to `screenshots/`.


### Group lifecycle
Groups stay open while any rider is on their trip. They close when the admin cancels or all riders end their trip. See STATUS.md.


## Feedback
More → Feedback: bug / idea / other + message + optional contact. Auto-attaches app version and device/browser info (never location). Queued offline in IndexedDB and retried. Server: `POST /api/feedback`, owner reads via `GET /api/feedback` with `ADMIN_TOKEN` (see DEPLOY.md; Render free disk is ephemeral).

### Group communication (quick messages + push-to-talk)
In the Group tab: seven one-tap messages (Stop, Fuel, Tea break, Slow down, Wait for me, Turn ahead, Need help) go to everyone in the group and appear as a toast with the sender's name (optional beep/vibrate), plus a message log. **Hold to talk** records up to 15 s with `MediaRecorder` (~16 kbps Opus) and uploads it; members get a message carrying a clip id over the existing SSE channel and can auto-play it or tap Play.

API (all need the rider token): `POST /api/groups/:code/say {token,type}`; `POST /api/groups/:code/voice?token=&dur=<ms>` (raw `audio/webm|ogg|mp4` body); `GET /api/groups/:code/clip/:id?token=`. SSE events: `msg` (one message) and `log` (last 20 on connect), next to `state`.
Server limits (all in memory, nothing on disk): clip <= 96 KB, 5 clips / 30 s per rider, 30 / 10 min per group, max 8 clips and 512 KB held per group, clips deleted after 3 min; quick messages 8 / 10 s per rider, 60 / min per group; log keeps 50.
Limitations: not tested on real phones; works only while the app is open on screen (a web page/WebView cannot record or play with the screen locked); no Bluetooth intercom; needs mic permission (Android `RECORD_AUDIO` in the Capacitor manifest).
Tests: `node tests/messages.test.js` (multi-client server) and `node tests/e2e.messages.js` (two headless Chrome riders with a fake microphone).
