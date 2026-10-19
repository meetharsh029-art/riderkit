// Malhiva extra pure logic (stages 1-7). Browser: window.Extra. Node: module.exports. No DOM, no network.
(function (root) {
  const APP_NAME = 'Malhiva'; // keep in sync with Core.APP_NAME (this file also runs in the service worker, where Core is absent)
  const pad = n => String(n).padStart(2, '0');
  const isoOf = ms => { const d = new Date(ms); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }; // local calendar day
  const dayNum = s => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '')); if (!m) return null; const t = Date.UTC(+m[1], +m[2] - 1, +m[3]); return new Date(t).toISOString().slice(0, 10) === s ? t / 864e5 : null; };
  const todayNum = now => dayNum(isoOf(now == null ? Date.now() : now));
  const addDays = (iso, d) => { const n = dayNum(iso); return n === null ? null : new Date((n + d) * 864e5).toISOString().slice(0, 10); };

  // ===== Stage 1: reminders (service / tyre / PUC / insurance / DL by DATE) =====
  // Only things that have a calendar date are reminded. Service items that are due by km only have no date and are NOT included.
  // docs: [{type,name,expiry}]; items: service items of the active vehicle; tyres: {front:{installDate,lastPressure},rear:{...}} (active vehicle)
  const TYRE_AGE_DAYS = 5 * 365, TYRE_PRESSURE_DAYS = 14;
  function buildReminders(o) {
    o = o || {}; const out = [], add = (id, title, due, kind) => { if (dayNum(due) !== null) out.push({ id, title, due, kind }); };
    for (const d of o.docs || []) if (d && d.expiry) add('doc-' + d.type, (d.name || d.type).replace(/\s*\(.*\)$/, '') + ' expiry', d.expiry, 'doc');
    for (const it of o.items || []) if (it && it.lastDate && it.dayInterval > 0) add('svc-' + it.id, it.name || 'Service', addDays(it.lastDate, Math.round(it.dayInterval)), 'service');
    const T = o.tyres || {}; for (const p of ['front', 'rear']) { const t = T[p]; if (!t) continue;
      if (t.installDate) add('tyre-age-' + p, p + ' tyre is 5 years old (replace check)', addDays(t.installDate, TYRE_AGE_DAYS), 'tyre');
      if (t.lastPressure) add('tyre-psi-' + p, 'Check ' + p + ' tyre pressure', addDays(t.lastPressure, TYRE_PRESSURE_DAYS), 'tyre'); }
    const seen = new Set(); return out.filter(r => !seen.has(r.id) && seen.add(r.id)).slice(0, 60);
  }
  const stageFor = days => { if (days < 0) return days >= -14 ? -1 : null; for (const l of [0, 1, 7, 30]) if (days <= l) return l; return null; };
  const phrase = days => days < 0 ? 'was due ' + (-days) + ' day' + (days === -1 ? '' : 's') + ' ago' : days === 0 ? 'is due today' : days === 1 ? 'is due tomorrow' : 'is due in ' + days + ' days';
  // Local (no-server) fallback: which reminders should be shown now? `shown` = {"id@stage": true} persisted by the caller. Returns {show:[{key,title,body,url}], shown}.
  function localPlan(reminders, shown, now, max) {
    shown = Object.assign({}, shown); const today = todayNum(now), show = []; max = max || 3;
    for (const r of reminders || []) { if (show.length >= max) break; const days = dayNum(r.due) - today, st = stageFor(days); if (st === null) continue; const key = r.id + '@' + st + '@' + r.due; if (shown[key]) continue;
      shown[key] = today; show.push({ key, title: APP_NAME + ': ' + r.title, body: r.title + ' ' + phrase(days) + '.', url: './#' + (r.kind === 'doc' ? 'docs' : 'service'), tag: 'rk-' + r.id }); }
    for (const k of Object.keys(shown)) if (today - shown[k] > 400) delete shown[k]; return { show, shown };
  }
  const urlB64ToBytes = s => { const p = '='.repeat((4 - s.length % 4) % 4), b = (s + p).replace(/-/g, '+').replace(/_/g, '/'); const bin = typeof atob === 'function' ? atob(b) : Buffer.from(b, 'base64').toString('binary'); return Uint8Array.from(bin, c => c.charCodeAt(0)); };

  // ===== Stage 2: pins =====
  const PIN_TYPES = { pothole: { label: 'Pothole / bad road', short: '!', color: '#b91c1c', hazard: true }, puncture: { label: 'Puncture shop', short: 'T', color: '#b45309' }, mechanic: { label: 'Mechanic', short: 'M', color: '#2563eb' }, dhaba: { label: 'Dhaba / food', short: 'D', color: '#15803d' }, fuel: { label: 'Fuel station', short: 'F', color: '#7c3aed' } };
  const bboxAround = (lat, lng, km) => { const dl = km / 111.2, dn = km / (111.2 * Math.max(0.2, Math.cos(lat * Math.PI / 180))); return [lat - dl, lng - dn, lat + dl, lng + dn]; };
  const pinAge = (ms, now) => { const d = Math.max(0, Math.round(((now == null ? Date.now() : now) - ms) / 864e5)); return d === 0 ? 'today' : d === 1 ? 'yesterday' : d < 60 ? d + ' days ago' : Math.round(d / 30) + ' months ago'; };
  const pinLeft = (exp, now) => { const d = Math.round((exp - (now == null ? Date.now() : now)) / 864e5); return d <= 0 ? 'expires today' : d === 1 ? 'expires in 1 day' : d < 60 ? 'expires in ' + d + ' days' : 'expires in ' + Math.round(d / 30) + ' months'; };
  const inBox = (p, bb) => p.lat >= bb[0] && p.lat <= bb[2] && p.lng >= bb[1] && p.lng <= bb[3];
  const mergePinCache = (cache, pins, now, max) => { const m = Object.assign({}, cache); for (const p of pins) m[p.id] = Object.assign({ seenAt: now }, p, { seenAt: now }); const live = Object.values(m).filter(p => p.exp > now).sort((a, b) => b.seenAt - a.seenAt).slice(0, max || 400); return Object.fromEntries(live.map(p => [p.id, p])); };
  const newDeviceId = () => { const a = new Uint8Array(16); (typeof crypto !== 'undefined' && crypto.getRandomValues ? crypto : require('crypto').webcrypto).getRandomValues(a); return Array.from(a, b => b.toString(16).padStart(2, '0')).join(''); };

  // ===== Stage 3: navigation (off-route detection, auto re-route, voice prompts) =====
  const RAD = Math.PI / 180, R_EARTH = 6371008.8;
  const hav = (a, b) => { const dl = (b[0] - a[0]) * RAD, dn = (b[1] - a[1]) * RAD, h = Math.sin(dl / 2) ** 2 + Math.cos(a[0] * RAD) * Math.cos(b[0] * RAD) * Math.sin(dn / 2) ** 2; return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(h))); };
  // nearest point on a polyline [[lat,lng],...]: {dist metres, along metres from start, seg}
  function project(pt, line, cum) {
    let best = { dist: Infinity, along: 0, seg: 0 }; if (!line || line.length < 2) return line && line.length === 1 ? { dist: hav(pt, line[0]), along: 0, seg: 0 } : best;
    const k = Math.cos(pt[0] * RAD) * 111320, ky = 110574;
    for (let i = 0; i < line.length - 1; i++) {
      const ax = (line[i][1] - pt[1]) * k, ay = (line[i][0] - pt[0]) * ky, bx = (line[i + 1][1] - pt[1]) * k, by = (line[i + 1][0] - pt[0]) * ky, dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
      let u = l2 > 0 ? -(ax * dx + ay * dy) / l2 : 0; u = Math.max(0, Math.min(1, u)); const px = ax + u * dx, py = ay + u * dy, d = Math.hypot(px, py);
      if (d < best.dist) best = { dist: d, along: cum[i] + u * (cum[i + 1] - cum[i]), seg: i };
    } return best;
  }
  function buildNav(route) { // route = Core.parseRoute() output: {line, steps:[{text,dist,lat,lng}], distance, duration}
    const line = (route && route.line) || [], cum = [0]; for (let i = 1; i < line.length; i++) cum.push(cum[i - 1] + hav(line[i - 1], line[i]));
    const total = cum[cum.length - 1] || 0; let last = 0;
    const steps = ((route && route.steps) || []).map((s, i, a) => { let along = i === a.length - 1 ? total : (s.lat != null ? project([s.lat, s.lng], line, cum).along : null); if (along == null) along = last; along = Math.max(last, along); last = along; return { text: s.text, dist: s.dist, along }; });
    return { line, cum, total, steps };
  }
  const lcFirst = t => t ? t.charAt(0).toLowerCase() + t.slice(1) : t;
  const metresSay = m => m >= 1000 ? (Math.round(m / 100) / 10) + ' kilometres' : Math.max(50, Math.round(m / 50) * 50) + ' metres';
  const NAV = { offMin: 60, offMax: 150, offFixes: 3, offMs: 10000, cooldownMs: 25000, maxReroutes: 6, windowMs: 600000, bands: [500, 150, 30], arriveM: 40, passM: 20 };
  const newNavState = () => ({ spoken: {}, offCount: 0, offSince: null, rerouteAt: [], arrived: false, started: false });
  // One GPS fix -> what to show/say/do. fix = {lat,lng,acc,speed(m/s)|null}. Pure except it mutates `st`.
  function navUpdate(nav, st, fix, now) {
    const out = { off: false, dist: null, along: null, next: null, say: [], reroute: false, arrived: false, remaining: null };
    if (!nav || nav.line.length < 2) return out; now = now == null ? Date.now() : now;
    const pr = project([fix.lat, fix.lng], nav.line, nav.cum); out.dist = pr.dist; out.along = pr.along; out.remaining = Math.max(0, nav.total - pr.along);
    const thr = Math.max(NAV.offMin, Math.min(NAV.offMax, 40 + (fix.acc || 0)));
    if (pr.dist > thr) { st.offCount++; if (st.offSince == null) st.offSince = now; } else { st.offCount = 0; st.offSince = null; }
    out.off = st.offCount >= NAV.offFixes && now - st.offSince >= NAV.offMs;
    if (out.off) { st.rerouteAt = st.rerouteAt.filter(t => now - t < NAV.windowMs); const moving = fix.speed == null || fix.speed >= 1;
      if (moving && st.rerouteAt.length < NAV.maxReroutes && (!st.rerouteAt.length || now - st.rerouteAt[st.rerouteAt.length - 1] >= NAV.cooldownMs)) { out.reroute = true; st.rerouteAt.push(now); } return out; }
    if (st.offCount > 0) return out; // briefly off, wait before speaking nonsense
    if (st.arrived) { out.arrived = true; return out; }
    if (nav.total - pr.along <= NAV.arriveM && pr.dist <= thr) { st.arrived = true; out.arrived = true; out.say.push('You have arrived at your destination'); return out; }
    if (!st.started) { st.started = true; const s0 = nav.steps[0]; if (s0 && pr.along < 100) out.say.push('Starting navigation. ' + s0.text); }
    let idx = nav.steps.findIndex((s, i) => i > 0 && s.along - pr.along > -NAV.passM); if (idx < 0) idx = nav.steps.length - 1;
    const s = nav.steps[idx]; if (s) { const d = Math.max(0, s.along - pr.along); out.next = { idx, text: s.text, dist: d };
      if (idx < nav.steps.length - 1 || d > NAV.arriveM) { // last step is "arrive", handled above
        let band = null; for (const b of NAV.bands) if (d <= b) band = b; // smallest band we are inside
        if (band !== null) { const key = idx + '@' + band; if (!st.spoken[key]) { for (const b of NAV.bands) if (b >= band) st.spoken[idx + '@' + b] = 1; // never repeat bigger bands after a smaller one
          out.say.push(band === NAV.bands[NAV.bands.length - 1] ? s.text : 'In ' + metresSay(Math.min(d, band)) + ', ' + lcFirst(s.text)); } } } }
    return out;
  }
  const navKeyOf = route => route ? Math.round(route.distance) + ':' + route.line.length : '';

  // ===== Stage 5: map tile cache policy (OSM Tile Usage Policy: no prefetch, no bulk, no "save area"; cache what the user VIEWED, honour cache headers / >= 7 days) =====
  const TILE = { max: 600, minTtlMs: 7 * 864e5, maxTtlMs: 30 * 864e5 };
  const parseMaxAge = cc => { const m = /(?:^|[\s,])max-age=(\d+)/i.exec(String(cc || '')); return m ? +m[1] * 1000 : null; };
  // ttl for a freshly fetched tile: server's max-age if it sent one, else 7 days; never below 1 day for sanity, never above 30 days
  const tileTtl = cc => { const a = parseMaxAge(cc); return a === null ? TILE.minTtlMs : Math.max(864e5, Math.min(TILE.maxTtlMs, a)); };
  const tileFresh = (meta, now) => !!meta && now < meta.f + meta.ttl;
  // index = {url: {f: fetchedAt, ttl}}; returns urls to delete so at most `max` remain (oldest fetched first)
  function tileEvict(index, max) { const ks = Object.keys(index || {}); if (ks.length <= (max || TILE.max)) return []; ks.sort((a, b) => index[a].f - index[b].f); return ks.slice(0, ks.length - (max || TILE.max)); }
  const isTileUrl = u => /^https:\/\/tile\.openstreetmap\.org\/\d{1,2}\/\d+\/\d+\.png$/.test(u);

  // ===== Stage 6: expenses (integer paise; Malhiva only calculates, it never moves money) =====
  const hashN = str => { let h = 0; for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0; return h; };
  function parseRupees(str) { const t = String(str == null ? '' : str).replace(/[\u20b9,\s]/g, ''); if (!/^\d{1,7}(\.\d{1,2})?$/.test(t)) return null; const p = Math.round(parseFloat(t) * 100); return p >= 1 && p <= 10000000 ? p : null; }
  const fmtPaise = p => { const neg = p < 0; p = Math.abs(Math.round(p)); const r = Math.floor(p / 100), q = p % 100; return (neg ? '-' : '') + '\u20b9' + r.toLocaleString('en-IN') + (q ? '.' + String(q).padStart(2, '0') : ''); };
  // shares of one expense: {memberId: paise}; sums to exactly amount; the leftover paise go to different people for different expenses (by id hash)
  function shares(e) { const ids = [...new Set((e.with || []).map(String))].sort(); const n = ids.length; if (!n) return {}; const base = Math.floor(e.amount / n), rem = e.amount - base * n, off = hashN(String(e.id || '')) % n, out = {};
    ids.forEach((id, i) => { out[id] = base + (((i - off + n) % n) < rem ? 1 : 0); }); return out; }
  function balances(expenses) { const b = {}; for (const e of expenses || []) { if (!e || !Number.isInteger(e.amount) || e.amount <= 0 || !e.paidBy) continue; const sh = shares(e); if (!Object.keys(sh).length) continue; b[e.paidBy] = (b[e.paidBy] || 0) + e.amount; for (const [id, v] of Object.entries(sh)) b[id] = (b[id] || 0) - v; } return b; }
  // minimal-ish settlement: repeatedly match the biggest debtor with the biggest creditor. Returns [{from,to,amount}] in paise.
  function settleUp(bal) { const cr = [], db = []; for (const [id, v] of Object.entries(bal || {})) { if (v > 0) cr.push([id, v]); else if (v < 0) db.push([id, -v]); } const out = [];
    while (cr.length && db.length) { cr.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)); db.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)); const a = Math.min(cr[0][1], db[0][1]); out.push({ from: db[0][0], to: cr[0][0], amount: a }); cr[0][1] -= a; db[0][1] -= a; if (!cr[0][1]) cr.shift(); if (!db[0][1]) db.shift(); } return out; }
  const STOP_LABEL = { fuel: 'Fuel', food: 'Food / tea', rest: 'Rest', washroom: 'Washroom', photo: 'Photo stop', other: 'Other' };

  // ===== Stage 7: ride recap card (canvas). The route is drawn as a plain shape (no map tiles, no street names); start/end can be trimmed for privacy =====
  const RECAP = { W: 1080, H: 1350, trimM: 300, maxPts: 400 };
  function recapModel(ride, opts) {
    opts = Object.assign({ hideEnds: true }, opts); ride = ride || {}; const pts = (ride.points || []).filter(p => p && Number.isFinite(p.lat) && Number.isFinite(p.lon)); let use = pts, note = '';
    const seg = []; let total = 0; for (let i = 1; i < pts.length; i++) { const d = hav([pts[i - 1].lat, pts[i - 1].lon], [pts[i].lat, pts[i].lon]); seg.push(d); total += d; }
    if (opts.hideEnds && pts.length > 1) { if (total < RECAP.trimM * 2 + 100) { use = []; note = 'Route hidden (ride too short to hide the start and end)'; } else { let a = 0, acc = 0; while (a < seg.length && acc < RECAP.trimM) acc += seg[a++]; let z = seg.length, acc2 = 0; while (z > a && acc2 < RECAP.trimM) acc2 += seg[--z]; use = pts.slice(a, z + 1); note = 'First and last 300 m hidden'; } }
    if (use.length > RECAP.maxPts) { const step = (use.length - 1) / (RECAP.maxPts - 1); use = Array.from({ length: RECAP.maxPts }, (_, i) => use[Math.round(i * step)]); }
    let shape = []; if (use.length > 1) { const lat0 = Math.min(...use.map(p => p.lat)), lat1 = Math.max(...use.map(p => p.lat)), lon0 = Math.min(...use.map(p => p.lon)), lon1 = Math.max(...use.map(p => p.lon)), k = Math.cos((lat0 + lat1) / 2 * Math.PI / 180);
      const w = Math.max(1e-9, (lon1 - lon0) * k), h = Math.max(1e-9, lat1 - lat0), sc = 1 / Math.max(w, h); shape = use.map(p => [((p.lon - lon0) * k - w / 2) * sc, -((p.lat - lat0) - h / 2) * sc]); } // centred, longest side = 1, y down
    const km = (Number(ride.dist) || 0) / 1000, dur = Number(ride.dur) || 0, d = new Date(ride.start || Date.now());
    return { km: Math.round(km * 10) / 10, kmText: km >= 100 ? String(Math.round(km)) : km.toFixed(1), time: (dur >= 3600 ? Math.floor(dur / 3600) + ' h ' + String(Math.floor(dur % 3600 / 60)).padStart(2, '0') + ' m' : Math.max(0, Math.round(dur / 60)) + ' min'), avg: Math.round(Number(ride.avgSpeed) || 0), max: Math.round(Number(ride.maxSpeed) || 0),
      date: d.getDate() + ' ' + ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()] + ' ' + d.getFullYear(), shape, note, vehicle: String(ride.vehicleName || '').slice(0, 30), hidden: !!opts.hideEnds };
  }
  function drawRecap(ctx, m, W, H) { W = W || RECAP.W; H = H || RECAP.H; const F = 'Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
    const g = ctx.createLinearGradient(0, 0, W, H); g.addColorStop(0, '#0f172a'); g.addColorStop(1, '#1e3a8a'); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    ctx.textBaseline = 'alphabetic'; ctx.fillStyle = '#ffffff'; ctx.font = '700 54px ' + F; ctx.textAlign = 'left'; ctx.fillText(APP_NAME, 80, 120); ctx.textAlign = 'right'; ctx.font = '500 40px ' + F; ctx.fillStyle = '#cbd5e1'; ctx.fillText(m.date, W - 80, 120);
    const bx = 80, by = 190, bw = W - 160, bh = 640; ctx.fillStyle = 'rgba(255,255,255,0.07)'; if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(bx, by, bw, bh, 36); ctx.fill(); } else ctx.fillRect(bx, by, bw, bh);
    if (m.shape.length > 1) { const pad = 70, s = Math.min(bw, bh) - pad * 2, cx = bx + bw / 2, cy = by + bh / 2; ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.strokeStyle = '#60a5fa'; ctx.lineWidth = 14; ctx.beginPath(); m.shape.forEach((p, i) => { const x = cx + p[0] * s, y = cy + p[1] * s; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.stroke();
      const dot = (p, c) => { ctx.fillStyle = c; ctx.beginPath(); ctx.arc(cx + p[0] * s, cy + p[1] * s, 20, 0, Math.PI * 2); ctx.fill(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 6; ctx.stroke(); }; dot(m.shape[0], '#22c55e'); dot(m.shape[m.shape.length - 1], '#f97316'); }
    else { ctx.fillStyle = '#94a3b8'; ctx.textAlign = 'center'; ctx.font = '500 40px ' + F; ctx.fillText(m.note || 'No route recorded for this ride', W / 2, by + bh / 2); }
    ctx.textAlign = 'center'; ctx.fillStyle = '#ffffff'; ctx.font = '800 220px ' + F; ctx.fillText(m.kmText, W / 2, 1060); ctx.font = '600 52px ' + F; ctx.fillStyle = '#93c5fd'; ctx.fillText('kilometres' + (m.vehicle ? ' \u00b7 ' + m.vehicle : ''), W / 2, 1125);
    const cols = [['TIME', m.time], ['AVG', m.avg + ' km/h'], ['MAX', m.max + ' km/h']]; cols.forEach((c, i) => { const x = W / 6 + i * W / 3; ctx.fillStyle = '#93c5fd'; ctx.font = '600 32px ' + F; ctx.fillText(c[0], x, 1205); ctx.fillStyle = '#fff'; ctx.font = '700 46px ' + F; ctx.fillText(c[1], x, 1262); });
    ctx.fillStyle = '#94a3b8'; ctx.font = '500 28px ' + F; ctx.fillText(m.note ? m.note + ' \u00b7 riderkit.onrender.com' : 'riderkit.onrender.com', W / 2, 1316); }

  // ---- automatic SOS detector (crash + optional long stationary). Pure logic: feed it motion + speed samples. ----
  // Inputs: feedMotion({t ms, mag m/s2 incl. gravity}), feedSpeed({t ms, mps}), tick(t). Each returns null or {kind:'crash'|'stationary', reason}.
  // Crash = (impact peak >= impact OR speed drop >= decelMps2 * dt) while the rider was above minSpeed shortly before, FOLLOWED by a stop (speed <= stopSpeed for stopMs; motion-still when no fresh GPS speed).
  // Real-ride defaults (see CRASH_DETECTION.md). impact 30 m/s2 ~= 3.1 g total (incl. gravity); only counted if GPS speed was >= minSpeedMps (20 km/h) within speedAgeMs;
  // must be followed by a stop (GPS speed <= stopSpeed) or, without fresh GPS, motion-stillness (|a| within stillTol of 1 g) lasting stopMs, starting within windowMs of the impact.
  const AUTOSOS = { impact: 30, g: 9.81, minSpeedMps: 5.5, speedAgeMs: 6000, decelMps2: 8, decelMinDrop: 8, stopSpeed: 1.5, stopMs: 5000, stillTol: 1.5, windowMs: 10000, cooldownMs: 60000, stationary: false, stationaryMs: 600000, gpsStaleMs: 60000, moveMps: 2.5 };
  // Sensor TEST mode only (Settings > Test crash detection): no speed gate, ~2 g, 2 s still. Never used for a real ride, never sends anything.
  const AUTOSOS_TEST = { impact: 20, minSpeedMps: 0, stopMs: 2000, windowMs: 10000, cooldownMs: 3000, ignoreSpeed: true };
  // Arming state for the on-screen indicator. st: { on, supported, perm:'granted'|'needed'|'denied'|'unsupported', data:true|false|null, active, hidden, minKmh }
  function crashStatus(st) {
    st = st || {}; const mk = (level, label, reason, extra) => Object.assign({ level, armed: level === 'on' || level === 'limited', label, reason, needPerm: false }, extra || {});
    if (!st.on) return mk('off', 'Crash detection off', 'Switched off. Turn on \u201cAutomatic crash SOS\u201d on the Ride tab.');
    if (st.perm === 'needed') return mk('off', 'Crash detection off: motion permission needed', 'This phone asks before an app may read the motion sensors. Tap \u201cAllow motion sensors\u201d.', { needPerm: true });
    if (st.perm === 'denied') return mk('off', 'Crash detection off: motion permission denied', 'iPhone: fully close and reopen Malhiva, tap \u201cAllow motion sensors\u201d and choose Allow. Android Chrome: site settings \u203a Motion sensors \u203a Allow.', { needPerm: true });
    const noMotion = !st.supported || st.perm === 'unsupported' || st.data === false;
    const why = !st.supported || st.perm === 'unsupported' ? 'This browser has no motion sensors' : 'No motion data from the sensors yet';
    if (!st.active) return noMotion ? mk('standby', 'Crash detection limited (standby)', why + ': only a sudden GPS speed drop can trigger it. Arms when you start a ride or join a group ride.')
      : mk('standby', 'Crash detection ready (standby)', 'Arms automatically when you start a ride or join a group ride.');
    if (st.hidden) return mk('paused', 'Crash detection paused', 'The screen is off or Malhiva is in the background. Keep the app open with the screen on.');
    if (noMotion) return mk('limited', 'Crash detection on (GPS only)', why + ': only a sudden GPS speed drop can trigger it.');
    return mk('on', 'Crash detection on', 'Watching for a hard impact (about ' + ((st.impact || 30) / 9.81).toFixed(1) + ' g) above ' + (st.minKmh || 20) + ' km/h followed by a stop. Keep the screen on.');
  }
  class AutoSos {
    constructor(o) { this.o = Object.assign({}, AUTOSOS, o || {}); this.reset(); }
    reset() { this.peak = 0; this.hist = []; this.cand = null; this.stopSince = null; this.stillSince = null; this.lastMoveT = null; this.moved = false; this.statFired = false; this.coolUntil = 0; this.lastSpeed = null; this.lastSpeedT = null; }
    recentMax(t) { let m = 0; for (const h of this.hist) if (t - h.t <= this.o.speedAgeMs && h.mps > m) m = h.mps; return m; }
    fire(t, kind, reason) { this.coolUntil = t + this.o.cooldownMs; this.cand = null; this.stopSince = null; this.stillSince = null; if (kind === 'stationary') this.statFired = true; return { kind, reason }; }
    feedMotion(s) {
      const o = this.o; if (s.mag > this.peak) this.peak = s.mag; if (s.t < this.coolUntil) return null;
      if (!this.cand) { if (s.mag >= o.impact && (o.ignoreSpeed || this.recentMax(s.t) >= o.minSpeedMps)) { this.cand = { t: s.t, why: 'impact of ' + (s.mag / o.g).toFixed(1) + ' g' }; this.stopSince = null; this.stillSince = null; } return null; }
      if (s.t - this.cand.t < 500) return null;
      if (Math.abs(s.mag - o.g) <= o.stillTol) { if (this.stillSince === null) this.stillSince = s.t; } else this.stillSince = null;
      return this.check(s.t);
    }
    feedSpeed(s) {
      const o = this.o, t = s.t; if (s.mps == null || !(s.mps >= 0)) return null;
      this.lastSpeed = s.mps; this.lastSpeedT = t;
      if (s.mps >= o.moveMps) { this.lastMoveT = t; this.moved = true; if (s.mps >= o.minSpeedMps) this.statFired = false; }
      if (t >= this.coolUntil && !this.cand && s.mps <= o.stopSpeed) { // sudden deceleration from riding speed
        for (const h of this.hist) { const dt = (t - h.t) / 1000; if (dt >= 0.5 && dt <= 4 && h.mps >= o.minSpeedMps && h.mps - s.mps >= o.decelMinDrop && (h.mps - s.mps) / dt >= o.decelMps2) { this.cand = { t, why: 'speed fell ' + Math.round(h.mps * 3.6) + ' to ' + Math.round(s.mps * 3.6) + ' km/h in ' + dt.toFixed(1) + ' s' }; this.stopSince = t; break; } }
      }
      this.hist.push({ t, mps: s.mps }); this.hist = this.hist.filter(h => t - h.t <= 10000);
      if (this.cand) { if (s.mps <= o.stopSpeed) { if (this.stopSince === null) this.stopSince = t; } else this.stopSince = null; }
      return this.check(t);
    }
    tick(t) { return this.check(t); }
    check(t) {
      const o = this.o;
      if (this.cand) {
        if (t - this.cand.t > o.windowMs + o.stopMs) { this.cand = null; this.stopSince = null; this.stillSince = null; }
        else {
          const gpsFresh = !o.ignoreSpeed && this.lastSpeedT != null && t - this.lastSpeedT <= o.speedAgeMs;
          if (gpsFresh) { if (this.stopSince !== null && t - this.stopSince >= o.stopMs && this.lastSpeed <= o.stopSpeed) return this.fire(t, 'crash', this.cand.why + ', then stopped'); }
          else if (this.stillSince !== null && t - this.stillSince >= o.stopMs) return this.fire(t, 'crash', this.cand.why + ', then no movement');
        }
      }
      if (o.stationary && this.moved && !this.statFired && t >= this.coolUntil && this.lastSpeedT != null && t - this.lastSpeedT <= o.gpsStaleMs && this.lastSpeed <= o.stopSpeed && this.lastMoveT != null && t - this.lastMoveT >= o.stationaryMs)
        return this.fire(t, 'stationary', 'not moving for ' + Math.round((t - this.lastMoveT) / 60000) + ' min during a ride');
      return null;
    }
  }

  const api = { AutoSos, AUTOSOS, AUTOSOS_TEST, crashStatus, RECAP, recapModel, drawRecap, parseRupees, fmtPaise, shares, balances, settleUp, STOP_LABEL, TILE, parseMaxAge, tileTtl, tileFresh, tileEvict, isTileUrl, hav, project, buildNav, navUpdate, newNavState, navKeyOf, NAV, metresSay, PIN_TYPES, bboxAround, pinAge, pinLeft, inBox, mergePinCache, newDeviceId, isoOf, dayNum, todayNum, addDays, buildReminders, stageFor, phrase, localPlan, urlB64ToBytes, TYRE_AGE_DAYS, TYRE_PRESSURE_DAYS };
  if (typeof module !== 'undefined') module.exports = api; else root.Extra = api;
})(typeof self !== 'undefined' ? self : this);
