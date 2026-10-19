# Malhiva automatic crash SOS: how it works (SW v30)

Code: detector `AutoSos` + `AUTOSOS` / `AUTOSOS_TEST` + `crashStatus()` in `lib-extra.js`; wiring in `app.js` ("automatic SOS" section).
Tests: `tests/extra.test.js` (simulated samples), `tests/e2e.autosos.js`, `tests/e2e.crashdetect.js` (headless Chrome, dispatched DeviceMotionEvents).

## When it is armed
All of these must be true:
1. **Setting on**: "Automatic crash SOS" switch on the Ride tab (ON by default).
2. **A ride is active**: a solo ride is recording (Start ride) **or** you are in a group ride. Never armed on the home screen, in settings, or after Stop.
3. **Motion sensors usable**:
   - iPhone/iPad (Safari, installed PWA): `DeviceMotionEvent.requestPermission()` must be accepted. iOS only shows the prompt when it is called directly inside a tap.
     Malhiva asks on: Start ride, Create/Join/Rejoin group, switching crash SOS on, "Allow motion sensors" in the indicator, and "Test crash detection".
     On page load it makes one silent check (no prompt; iOS rejects it without a tap, which is *not* treated as a denial).
     If denied, iOS will not ask again until the app is fully closed and reopened.
   - Android Chrome: no prompt; works unless "Motion sensors" is blocked in site settings.
   - Without sensors (desktop, blocked) it runs "GPS only": only a sudden GPS speed drop can trigger it.
4. **App open, screen on**: browsers stop sending motion and GPS data when the screen is off or the app is in the background. The indicator then says "paused". Rides request a screen wake lock.

The indicator ("Crash detection on/off/ready/paused/limited" with the reason) is shown on the Ride tab, in the group ride screen, and in Settings > Crash detection.

## Real-ride thresholds (defaults)
| What | Value | Why |
|---|---|---|
| Impact | total acceleration incl. gravity >= **30 m/s2 (~3.1 g)** (Settings: Impact threshold) | Normal riding vibration and braking stay well below 2 g; real crashes are typically several g. |
| Speed gate | GPS speed >= **20 km/h** at some point in the **6 s** before the impact (Settings: min speed) | A phone dropped while parked/walking, or thrown at home, never counts. |
| Confirmation | after the impact (ignoring the first 0.5 s): GPS speed <= **1.5 m/s (5 km/h) for 5 s**, or, if GPS is not fresh, the phone lying **still** (|a| within 1.5 m/s2 of 1 g) **for 5 s** | A pothole or phone knock while riding on does not fire; a 3-4 s stop at a light does not fire. (v29 used 3 s.) |
| Stop must start within | **10 s** of the impact (v29: 15 s) | A pothole followed much later by an ordinary stop is not a crash. |
| Sudden deceleration (no impact needed) | from >= 20 km/h, drop >= 8 m/s (29 km/h) at >= 8 m/s2 within 0.5-4 s, to <= 5 km/h, then the same 5 s stop | Crash where the phone is cushioned (bag) but GPS sees an abrupt stop. Normal hard braking (~4-6 m/s2) does not fire. |
| Countdown | 15 s, full screen, beeps + vibration, big I'M OK button | Then: SOS alert to the group (if in one) + opens SMS/WhatsApp to the emergency contact. |
| Cooldown | 60 s after an event, 30 s after I'M OK | No repeated alarms. |
| Long stop (optional, off) | stopped 10 min during a ride | Separate "Are you OK?" prompt. |

## Why "throwing the phone on the bed" did not trigger
1. No ride was active (not armed at all), and/or
2. even with a ride open, speed was ~0 km/h, so the speed gate (>= 20 km/h) rejects any impact - by design, so drops at home or at a fuel stop never send an SOS;
3. a mattress cushions the landing: peak is often below 3 g;
4. on iPhone, motion permission may never have been granted: group rides asked only after the network call, which iOS does not count as a tap (fixed in v30).

## Test mode (Settings > Crash detection > Test crash detection)
Separate detector with `AUTOSOS_TEST`: impact >= **20 m/s2 (~2 g)**, **no speed gate, GPS ignored**, then **2 s** still. Shows the live strongest jolt, runs up to 60 s.
On trigger it shows the full-screen countdown titled "TEST ... Nothing will be sent". When it ends it **never** calls the group alert API and never opens SMS/WhatsApp.
The real-ride detector keeps its thresholds; the test mode does not change them.

## Not verified on real devices
Thresholds are reasoned and tested with simulated events only. Unknown: real peak g of motorcycle/scooter crashes with the phone in a mount, pocket or tank bag; accelerometer range/clipping on budget Android phones (some saturate around 2-4 g per axis, which can cap the measured peak); iOS permission behaviour across Safari vs installed PWA versions; how often background/screen-off pauses detection in practice.
