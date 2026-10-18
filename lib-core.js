// Pure logic, usable in browser (window.Core) and Node (module.exports) for tests.
(function (root) {
  const R = 6371008.8; // metres
  const rad = d => d * Math.PI / 180;
  function haversine(a, b) {
    const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }
  function totalDistance(pts) { let d = 0; for (let i = 1; i < pts.length; i++) d += haversine(pts[i - 1], pts[i]); return d; }
  // Accept a GPS fix? Drop poor accuracy and tiny jitter.
  function acceptFix(prev, fix, opts) {
    const o = Object.assign({ maxAcc: 50, minMove: 5 }, opts);
    if (fix.acc != null && fix.acc > o.maxAcc) return false;
    if (!prev) return true;
    return haversine(prev, fix) >= Math.max(o.minMove, 0) ;
  }
  const kmh = ms => ms * 3.6;
  function fmtDuration(s) { s = Math.round(s); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60; const p = n => String(n).padStart(2, '0'); return (h ? h + ':' : '') + p(m) + ':' + p(x); }
  function fmtKm(m) { return (m / 1000).toFixed(2); }
  function fmtINR(n) { return '₹' + Number(n || 0).toLocaleString('en-IN'); }

  // Crash detector: big impact spike, then stillness (≈gravity only) for stillMs.
  class CrashDetector {
    constructor(o) {
      this.o = Object.assign({ impact: 30, g: 9.81, stillTol: 1.5, stillMs: 3000, windowMs: 8000 }, o);
      this.reset();
    }
    reset() { this.impactT = null; this.stillSince = null; }
    // sample: {t (ms), mag (m/s², incl. gravity)}; returns true when crash is detected
    feed(s) {
      const o = this.o;
      if (this.impactT === null) {
        if (s.mag >= o.impact) { this.impactT = s.t; this.stillSince = null; }
        return false;
      }
      if (s.t - this.impactT > o.windowMs + o.stillMs) { this.reset(); return false; }
      if (s.t - this.impactT < 500) return false; // ignore the impact's own ringing
      if (Math.abs(s.mag - o.g) <= o.stillTol) {
        if (this.stillSince === null) this.stillSince = s.t;
        if (s.t - this.stillSince >= o.stillMs) { this.reset(); return true; }
      } else {
        this.stillSince = null; // movement resumed (e.g. a pothole, phone dropped in pocket)
        if (s.mag >= o.impact) this.impactT = s.t;
      }
      return false;
    }
  }
  function alertLinks(contact, name, loc) {
    const link = loc ? `https://maps.google.com/?q=${loc.lat.toFixed(6)},${loc.lon.toFixed(6)}` : '(location unavailable)';
    const msg = `EMERGENCY: ${name || 'A rider'} may have crashed. Please call them. Last location: ${link}`;
    const num = String(contact || '').replace(/[^\d+]/g, '');
    return {
      message: msg,
      sms: `sms:${num}?body=${encodeURIComponent(msg)}`,
      whatsapp: `https://wa.me/${num.replace(/^\+/, '')}?text=${encodeURIComponent(msg)}`,
    };
  }
  // Maintenance status. item: {kmInterval, dayInterval, lastKm, lastDate(ISO)}; odo = current odometer km
  function maintStatus(item, odo, now) {
    now = now || Date.now();
    const out = { due: false, soon: false, reasons: [] };
    if (item.kmInterval && item.lastKm != null) {
      const left = item.lastKm + item.kmInterval - odo;
      if (left <= 0) { out.due = true; out.reasons.push(`${Math.abs(Math.round(left))} km overdue`); }
      else if (left <= item.kmInterval * 0.1) { out.soon = true; out.reasons.push(`${Math.round(left)} km left`); }
      else out.reasons.push(`${Math.round(left)} km left`);
    }
    if (item.dayInterval && item.lastDate) {
      const left = Math.round((new Date(item.lastDate).getTime() + item.dayInterval * 864e5 - now) / 864e5);
      if (left <= 0) { out.due = true; out.reasons.push(`${Math.abs(left)} days overdue`); }
      else if (left <= Math.max(7, item.dayInterval * 0.1)) { out.soon = true; out.reasons.push(`${left} days left`); }
      else out.reasons.push(`${left} days left`);
    }
    return out;
  }

  // ---- Document expiry. doc: {type, expiry:'YYYY-MM-DD'}. Dates are compared as local calendar days.
  const DOC_TYPES = { insurance: 'Insurance', puc: 'PUC (pollution certificate)', dl: 'Driving licence', rc: 'RC (registration certificate)' };
  function dayNum(iso) { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || '')); if (!m) return null;
    const d = Date.UTC(+m[1], +m[2] - 1, +m[3]); const chk = new Date(d);
    if (chk.getUTCMonth() !== +m[2] - 1 || chk.getUTCDate() !== +m[3]) return null; return d / 864e5; }
  function todayNum(now) { const d = new Date(now == null ? Date.now() : now); return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 864e5; }
  // -> {state:'none'|'expired'|'soon'|'ok', days (negative = days ago), label}
  function docStatus(doc, now, warnDays) {
    warnDays = warnDays == null ? 30 : warnDays;
    const e = dayNum(doc && doc.expiry); if (e === null) return { state: 'none', days: null, label: 'No expiry date set' };
    const days = e - todayNum(now);
    if (days < 0) return { state: 'expired', days, label: `Expired ${-days} day${-days === 1 ? '' : 's'} ago` };
    if (days === 0) return { state: 'soon', days, label: 'Expires today' };
    if (days <= warnDays) return { state: 'soon', days, label: `Expires in ${days} day${days === 1 ? '' : 's'}` };
    return { state: 'ok', days, label: `Valid, ${days} days left` };
  }
  // docs: array; returns the ones needing an alert, most urgent first
  function docAlerts(docs, now) {
    return (docs || []).map(d => Object.assign({ doc: d }, docStatus(d, now))).filter(x => x.state === 'expired' || x.state === 'soon').sort((a, b) => a.days - b.days);
  }

  // ---- GPX 1.1
  const xmlEsc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
  const xmlUnesc = s => String(s).replace(/&(lt|gt|quot|apos|amp|#\d+|#x[0-9a-fA-F]+);/g, (m, g) => ({ lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' }[g] || (g[1] === 'x' ? String.fromCodePoint(parseInt(g.slice(2), 16)) : String.fromCodePoint(+g.slice(1)))));
  // ride: {start(ms), points:[{lat,lon,t(ms)}], name?, notes?}
  function toGPX(ride, name) {
    const nm = name || ride.name || 'RiderKit ride ' + new Date(ride.start).toISOString();
    const pts = (ride.points || []).filter(p => isFinite(p.lat) && isFinite(p.lon));
    const trkpts = pts.map(p => `      <trkpt lat="${Number(p.lat).toFixed(6)}" lon="${Number(p.lon).toFixed(6)}">` +
      (p.t ? `<time>${new Date(p.t).toISOString()}</time>` : '') + '</trkpt>').join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="RiderKit" xmlns="http://www.topografix.com/GPX/1/1" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">\n` +
      `  <metadata><name>${xmlEsc(nm)}</name>${ride.start ? `<time>${new Date(ride.start).toISOString()}</time>` : ''}</metadata>\n` +
      `  <trk>\n    <name>${xmlEsc(nm)}</name>\n    <trkseg>\n${trkpts}${trkpts ? '\n' : ''}    </trkseg>\n  </trk>\n</gpx>\n`;
  }
  // Tolerant parser: track points, route points and waypoints. Throws on non-GPX or no points.
  function parseGPX(text) {
    text = String(text || '');
    if (!/<gpx[\s>]/i.test(text)) throw new Error('Not a GPX file');
    const nameM = /<(?:trk|rte)[^>]*>\s*(?:<[^>]*>\s*)*?<name>([\s\S]*?)<\/name>/i.exec(text) || /<metadata[^>]*>[\s\S]*?<name>([\s\S]*?)<\/name>/i.exec(text);
    const grab = tag => { const out = []; const re = new RegExp(`<${tag}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</${tag}>)`, 'gi'); let m;
      while ((m = re.exec(text))) { const a = m[1]; const la = /\blat\s*=\s*["']([^"']+)["']/i.exec(a), lo = /\blon\s*=\s*["']([^"']+)["']/i.exec(a);
        if (!la || !lo) continue; const lat = parseFloat(la[1]), lon = parseFloat(lo[1]);
        if (!(lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180)) continue;
        const tm = m[2] && /<time>\s*([^<]+?)\s*<\/time>/i.exec(m[2]); const t = tm ? Date.parse(tm[1]) : NaN;
        out.push(isNaN(t) ? { lat, lon } : { lat, lon, t }); } return out; };
    let points = grab('trkpt'); if (!points.length) points = grab('rtept'); if (!points.length) points = grab('wpt');
    if (!points.length) throw new Error('GPX has no points');
    return { name: nameM ? xmlUnesc(nameM[1].trim()) : 'Imported route', points };
  }

  // ---- Roadside help
  const DEFAULT_CONTACTS = () => [
    { id: 'def-112', name: 'Emergency (national)', number: '112', note: 'India single emergency number', verify: true },
    { id: 'def-1033', name: 'National Highway helpline', number: '1033', note: 'NHAI highway helpline', verify: true },
    { id: 'def-tow', name: 'Towing service', number: '', note: 'Add your local number', verify: false },
    { id: 'def-mech', name: 'Mechanic', number: '', note: 'Add your local number', verify: false },
    { id: 'def-ins', name: 'Insurance helpline', number: '', note: 'Number is on your policy', verify: false },
  ];
  const telLink = n => { const d = String(n || '').replace(/[^\d+*#]/g, ''); return d ? 'tel:' + d : ''; };
  function shareLocationLinks(num, name, loc) {
    const link = loc ? `https://maps.google.com/?q=${loc.lat.toFixed(6)},${loc.lon.toFixed(6)}` : null;
    const message = link ? `${name || 'A rider'} needs roadside help. My last known location: ${link}` : `${name || 'A rider'} needs roadside help. (Location unavailable - please call me.)`;
    const d = String(num || '').replace(/[^\d+]/g, '');
    return { message, sms: `sms:${d}?body=${encodeURIComponent(message)}`,
      whatsapp: d ? `https://wa.me/${d.replace(/^\+/, '')}?text=${encodeURIComponent(message)}` : `https://wa.me/?text=${encodeURIComponent(message)}` };
  }

  // ---- group ride helpers ----
  const STOP_MS = 3 * 60e3, STALE_MS = 60e3, BEHIND_M = 2000;
  // members: server snapshot members; now: server-adjusted clock. Returns members + derived distance/flags.
  function groupFlags(members, dest, now, o) {
    o = Object.assign({ stopMs: STOP_MS, staleMs: STALE_MS, behindM: BEHIND_M }, o);
    const rows = members.map(m => { const has = m.lat != null && m.lng != null; const pos = has ? { lat: m.lat, lon: m.lng } : null;
      const online = now - m.lastSeen < o.staleMs;
      return Object.assign({}, m, { hasPos: has, online, distToDest: has && dest ? haversine(pos, { lat: dest.lat, lon: dest.lng }) : null,
        stopped: has && online && m.movedAt != null && now - m.movedAt >= o.stopMs, behind: false, behindBy: null }); });
    const act = rows.filter(r => r.hasPos && r.online);
    if (act.length >= 2) {
      if (dest) { const lead = Math.min(...act.map(r => r.distToDest)); act.forEach(r => { r.behindBy = r.distToDest - lead; r.behind = r.behindBy > o.behindM; }); }
      else { const c = { lat: act.reduce((a, r) => a + r.lat, 0) / act.length, lon: act.reduce((a, r) => a + r.lng, 0) / act.length };
        act.forEach(r => { r.behindBy = haversine({ lat: r.lat, lon: r.lng }, c); r.behind = r.behindBy > o.behindM * 1.5; }); }
    }
    return rows;
  }
  function fmtAgo(ms) { const s = Math.max(0, Math.round(ms / 1000)); if (s < 10) return 'just now'; if (s < 60) return s + 's ago'; if (s < 3600) return Math.floor(s / 60) + ' min ago'; return Math.floor(s / 3600) + ' h ago'; }
  function fmtDist(m) { return m == null ? '–' : m < 1000 ? Math.round(m / 10) * 10 + ' m' : (m / 1000).toFixed(m < 10000 ? 1 : 0) + ' km'; }
  function normCode(c) { c = String(c || '').toUpperCase().replace(/\s/g, ''); if (/^\d{4}$/.test(c)) c = 'RIDE-' + c; return c.replace(/^RIDE(\d{4})$/, 'RIDE-$1'); }
  function codeFromSearch(search) { const m = /[?&]join=([^&#]*)/i.exec(search || ''); if (!m) return ''; let v = ''; try { v = decodeURIComponent(m[1]); } catch { return ''; } v = normCode(v); return /^RIDE-\d{4}$/.test(v) ? v : ''; }
  function gmapsLink(dest, origin) { let u = 'https://www.google.com/maps/dir/?api=1&destination=' + dest.lat.toFixed(6) + ',' + dest.lng.toFixed(6) + '&travelmode=driving';
    if (origin) u += '&origin=' + origin.lat.toFixed(6) + ',' + origin.lon.toFixed(6); return u; }
  // OSRM step -> human text
  function stepText(st) {
    const mv = st.maneuver || {}, type = mv.type, mod = mv.modifier, name = st.name ? ' onto ' + st.name : '';
    const dir = { 'sharp left': 'sharp left', left: 'left', 'slight left': 'slight left', straight: 'straight', 'slight right': 'slight right', right: 'right', 'sharp right': 'sharp right', uturn: 'a U-turn' };
    const d = dir[mod] || '';
    switch (type) {
      case 'depart': return 'Head' + (st.name ? ' on ' + st.name : ' out');
      case 'arrive': return 'Arrive at destination' + (d && mod !== 'straight' ? ' (on the ' + d + ')' : '');
      case 'roundabout': case 'rotary': return 'Enter the roundabout' + (mv.exit ? ', take exit ' + mv.exit : '') + (st.name ? ' onto ' + st.name : '');
      case 'exit roundabout': case 'exit rotary': return 'Exit the roundabout' + name;
      case 'merge': return 'Merge' + (d ? ' ' + d : '') + name;
      case 'fork': return 'Keep ' + (d || 'on') + ' at the fork' + name;
      case 'on ramp': case 'off ramp': return 'Take the ramp' + (d ? ' on the ' + d : '') + name;
      case 'end of road': return 'At the end of the road turn ' + (d || 'ahead') + name;
      case 'continue': return (mod === 'straight' || !d ? 'Continue straight' : 'Continue ' + d) + name;
      case 'new name': return 'Continue' + name;
      default: return (mod === 'uturn' ? 'Make a U-turn' : d ? (mod === 'straight' ? 'Go straight' : 'Turn ' + d) : 'Continue') + name;
    }
  }
  function parseRoute(j) {
    if (!j || j.code !== 'Ok' || !j.routes || !j.routes[0]) throw new Error((j && j.message) || 'no route found');
    const r = j.routes[0]; const steps = [];
    (r.legs || []).forEach(l => (l.steps || []).forEach(s => steps.push({ text: stepText(s), dist: s.distance, lat: s.maneuver && s.maneuver.location ? s.maneuver.location[1] : null, lng: s.maneuver && s.maneuver.location ? s.maneuver.location[0] : null })));
    return { distance: r.distance, duration: r.duration, line: r.geometry.coordinates.map(c => [c[1], c[0]]), steps };
  }
  // ---- v4: dashboard statistics (all pure; `now` in ms; days/weeks/months use the device's LOCAL calendar)
  const dayKey = ms => { const d = new Date(ms); return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate(); };
  const monthKey = ms => { const d = new Date(ms); return d.getFullYear() * 12 + d.getMonth(); };
  const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], MN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  // rides: [{start(ms), dist(m), dur(s), maxSpeed(km/h)}] -> totals + week/month + last-7-days + last-6-months series
  function rideStats(rides, now) {
    now = now == null ? Date.now() : now; rides = (rides || []).filter(r => r && isFinite(r.start));
    const num = v => (isFinite(v) && v > 0 ? +v : 0);
    const totalM = rides.reduce((s, r) => s + num(r.dist), 0), totalS = rides.reduce((s, r) => s + num(r.dur), 0);
    const out = { count: rides.length, totalKm: totalM / 1000, totalSec: totalS, topSpeed: rides.reduce((m, r) => Math.max(m, num(r.maxSpeed)), 0),
      avgSpeed: totalS > 0 ? kmh(totalM / totalS) : 0, last: rides.slice().sort((a, b) => b.start - a.start)[0] || null };
    // last 7 local days, oldest first (setDate keeps local-day arithmetic correct across DST)
    out.days = []; const base = new Date(now); base.setHours(12, 0, 0, 0);
    for (let i = 6; i >= 0; i--) { const d = new Date(base); d.setDate(d.getDate() - i); const k = dayKey(d.getTime());
      const rs = rides.filter(r => dayKey(r.start) === k); out.days.push({ key: k, label: WD[d.getDay()], km: rs.reduce((s, r) => s + num(r.dist), 0) / 1000, rides: rs.length }); }
    out.months = []; const nd = new Date(now);
    for (let i = 5; i >= 0; i--) { const d = new Date(nd.getFullYear(), nd.getMonth() - i, 1); const k = monthKey(d.getTime());
      const rs = rides.filter(r => monthKey(r.start) === k); out.months.push({ key: k, label: MN[d.getMonth()], km: rs.reduce((s, r) => s + num(r.dist), 0) / 1000, rides: rs.length, sec: rs.reduce((s, r) => s + num(r.dur), 0) }); }
    const mon = new Date(now); mon.setHours(0, 0, 0, 0); mon.setDate(mon.getDate() - ((mon.getDay() + 6) % 7)); // Monday 00:00 local
    const wk = rides.filter(r => r.start >= mon.getTime() && r.start <= now);
    out.week = { km: wk.reduce((s, r) => s + num(r.dist), 0) / 1000, rides: wk.length, sec: wk.reduce((s, r) => s + num(r.dur), 0) };
    const mo = out.months[5]; out.month = { km: mo.km, rides: mo.rides, sec: mo.sec };
    return out;
  }
  // "Places covered": distinct grid cells touched by any saved route. Default 0.05 deg (~5.5 km north-south). An approximation, not a real place count.
  const CELL_DEG = 0.05;
  const cellOf = (lat, lon, deg) => { deg = deg || CELL_DEG; return Math.floor(lat / deg) + ',' + Math.floor(lon / deg); };
  function gridCells(rides, deg) {
    deg = deg || CELL_DEG; const set = new Map();
    (rides || []).forEach(r => (r.points || []).forEach(p => { if (!p || !isFinite(p.lat) || !isFinite(p.lon) || Math.abs(p.lat) > 90 || Math.abs(p.lon) > 180) return;
      const k = cellOf(p.lat, p.lon, deg); if (!set.has(k)) { const [i, j] = k.split(',').map(Number); set.set(k, { key: k, lat: (i + 0.5) * deg, lon: (j + 0.5) * deg }); } }));
    return [...set.values()];
  }
  // Thin a route to at most `max` points for drawing (keeps first and last).
  function thin(points, max) { points = points || []; max = max || 300; if (points.length <= max) return points.slice(); const step = (points.length - 1) / (max - 1); const o = []; for (let i = 0; i < max; i++) o.push(points[Math.round(i * step)]); return o; }
  // Most urgent maintenance item. progress = share of the interval already used (max of km and days); 1 = due.
  function nextService(items, odo, now) {
    now = now == null ? Date.now() : now; let best = null;
    (items || []).forEach(it => {
      let prog = null, leftKm = null, leftDays = null;
      if (it.kmInterval && it.lastKm != null) { leftKm = it.lastKm + it.kmInterval - odo; prog = Math.max(prog || 0, (it.kmInterval - leftKm) / it.kmInterval); }
      if (it.dayInterval && it.lastDate) { const t = new Date(it.lastDate).getTime(); if (isFinite(t)) { leftDays = Math.round((t + it.dayInterval * 864e5 - now) / 864e5); prog = Math.max(prog || 0, (it.dayInterval - leftDays) / it.dayInterval); } }
      if (prog === null) return; prog = Math.max(0, prog);
      if (!best || prog > best.progress) best = { item: it, progress: prog, leftKm, leftDays, status: maintStatus(it, odo, now) };
    });
    return best;
  }
  // Tyre tracking. tyre: {installKm (odometer at fitting), installDate 'YYYY-MM-DD', lastPressure 'YYYY-MM-DD'?, brand?}
  // Guidance values are GENERIC rules of thumb (not a manufacturer spec): pressure weekly, inspection every 1,000 km, replace-by guide 25,000 km / 5 years.
  const TYRE_GUIDE = { pressureDays: 7, checkKm: 1000, lifeKm: 25000, maxAgeDays: 5 * 365 };
  function tyreStatus(t, odo, now, g) {
    g = Object.assign({}, TYRE_GUIDE, g); now = now == null ? Date.now() : now;
    if (!t || t.installKm == null || !isFinite(t.installKm)) return null;
    const kmSince = Math.max(0, odo - t.installKm); const inst = dayNum(t.installDate);
    const daysSince = inst === null ? null : Math.max(0, Math.round(todayNum(now) - inst));
    const pr = dayNum(t.lastPressure); const pressureAgo = pr === null ? null : Math.max(0, Math.round(todayNum(now) - pr));
    const kmToCheck = g.checkKm - (kmSince % g.checkKm);
    const lifePct = Math.min(1.5, kmSince / g.lifeKm);
    const ageWarn = daysSince !== null && daysSince >= g.maxAgeDays;
    const state = lifePct >= 1 || ageWarn ? 'replace' : lifePct >= 0.8 ? 'watch' : 'ok';
    return { kmSince, daysSince, kmToCheck, checkKm: g.checkKm, lifePct, lifeKm: g.lifeKm, ageWarn, pressureAgo, pressureDue: pressureAgo === null || pressureAgo >= g.pressureDays, pressureDays: g.pressureDays, state };
  }
  // Deterministic sample data for the demo toggle (never written to the database). Routes follow rough road corridors around Bengaluru.
  function demoData(now) {
    now = now == null ? Date.now() : now; let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const corridors = [
      [[12.9716, 77.5946], [13.0827, 77.5877], [13.2257, 77.5750], [13.3702, 77.6835]],   // north (Nandi hills side)
      [[12.9716, 77.5946], [12.9141, 77.4800], [12.8000, 77.2200], [12.5200, 76.8950]],   // south-west towards Mandya
      [[12.9716, 77.5946], [12.9250, 77.6700], [12.8450, 77.6600], [12.7400, 77.8200]],   // south-east (Hosur side)
      [[12.9716, 77.5946], [13.0100, 77.7000], [13.0700, 77.8000], [13.1350, 77.9900]],   // east
      [[12.9716, 77.5946], [12.9352, 77.6245], [12.9784, 77.6408], [12.9716, 77.5946]],   // city loop
    ];
    const rides = [], daysAgo = [0, 1, 2, 4, 6, 9, 12, 17, 24, 33, 48, 63, 85, 110, 140];
    daysAgo.forEach((da, i) => {
      const cor = corridors[i % corridors.length], pts = []; const start = now - da * 864e5 - (6 + (i % 5)) * 36e5; let t = start;
      for (let s = 0; s < cor.length - 1; s++) { const a = cor[s], b = cor[s + 1]; const n = Math.max(2, Math.round(haversine({ lat: a[0], lon: a[1] }, { lat: b[0], lon: b[1] }) / 250));
        for (let k = (s ? 1 : 0); k <= n; k++) { const f = k / n; pts.push({ lat: a[0] + (b[0] - a[0]) * f + (rnd() - .5) * 0.0006, lon: a[1] + (b[1] - a[1]) * f + (rnd() - .5) * 0.0006, t: (t += 14000) }); } }
      const dist = totalDistance(pts), dur = (pts[pts.length - 1].t - start) / 1000 + 600;
      rides.push({ id: 'demo' + i, start, end: start + dur * 1000, dur, dist, avgSpeed: kmh(dist / dur), maxSpeed: 62 + (i * 7) % 48, points: pts, notes: '', photos: [], demo: true });
    });
    const d = o => new Date(now + o * 864e5).toISOString().slice(0, 10);
    const odoBase = 12400; const odo = odoBase + rides.reduce((s, r) => s + r.dist, 0) / 1000;
    return { rides, odoBase, odo, vehicle: { id: 'demo-v', type: 'bike', make: 'Demo', model: 'Rider 250', year: 2022, fuel: 'petrol', odo: odoBase },
      maint: [{ id: 'dm1', vehicleId: 'demo-v', name: 'Oil change', kmInterval: 3000, dayInterval: 180, lastKm: Math.round(odo - 2450), lastDate: d(-96) },
              { id: 'dm2', vehicleId: 'demo-v', name: 'Chain lube/adjust', kmInterval: 600, dayInterval: null, lastKm: Math.round(odo - 210), lastDate: d(-12) }],
      tyres: { front: { brand: 'Demo Tyres F', installKm: Math.round(odo - 9400), installDate: d(-310), lastPressure: d(-3) }, rear: { brand: 'Demo Tyres R', installKm: Math.round(odo - 21300), installDate: d(-640), lastPressure: d(-11) } },
      docs: { insurance: { expiry: d(12) }, puc: { expiry: d(160) }, dl: { expiry: d(900) }, rc: { expiry: d(2000) } } };
  }
  // ---- v4: vehicles + generic service schedules
  // These are GENERIC rules of thumb, NOT manufacturer specs. The UI labels them "verify against your owner's manual".
  const VEHICLE_TYPES = { bike: 'Bike / motorcycle', car: 'Car' };
  const FUELS = { bike: ['petrol', 'electric'], car: ['petrol', 'diesel', 'cng', 'hybrid', 'electric'] };
  const MONTH_DAYS = 30.4375;
  const monthsToDays = m => (m ? Math.round(m * MONTH_DAYS) : null);
  const daysToMonths = d => (d ? Math.max(1, Math.round(d / MONTH_DAYS)) : null);
  // Returns [{name, kmInterval|null, monthInterval|null}]
  function suggestSchedule(type, fuel) {
    const ev = fuel === 'electric', diesel = fuel === 'diesel', cng = fuel === 'cng', hybrid = fuel === 'hybrid';
    const L = [];
    const add = (name, km, months) => L.push({ name, kmInterval: km || null, monthInterval: months || null });
    if (type === 'bike') {
      if (!ev) { add('Engine oil change', 3000, 6); add('Oil filter', 6000, 12); add('Air filter', 6000, 12); add('Spark plug', 8000, 24); }
      add('Chain clean & lube', 500, null); if (!ev) add('Chain adjust / slack check', 1000, null);
      add('Chain & sprocket (belt/chain replace)', 20000, null);
      add('Brake pads (inspect/replace)', 8000, 12); add('Brake fluid', null, 24);
      if (!ev) add('Coolant (if liquid-cooled)', 24000, 24);
      add('Tyres (inspect/replace)', 5000, 12); add('Battery check', null, 12); add('General service', ev ? 5000 : 6000, 6);
    } else {
      if (!ev) { add('Engine oil & filter', cng ? 5000 : 10000, 12); add('Air filter', 15000, 24); }
      add('Cabin / AC filter', 15000, 12);
      if (diesel) add('Fuel filter', 20000, 24);
      if (!ev && !diesel) add('Spark plugs', 30000, 36);
      add('Brake pads (inspect/replace)', 30000, 24); add('Brake fluid', null, 24);
      add('Coolant', 40000, 24); add('Tyre rotation & alignment', 10000, 6); add('Tyres (replace)', 40000, 60);
      if (!ev) add('Timing belt (if fitted)', 60000, 60);
      if (!ev) add('Gearbox / transmission fluid', 40000, 36);
      add('Battery check', null, 12); add('General service', 10000, 12);
      if (hybrid) add('Hybrid system check', 20000, 12);
    }
    return L;
  }
  // -> {ok, errors[], value} ; value is a clean vehicle object
  function normalizeVehicle(v, nowYear) {
    v = v || {}; const errors = []; const maxY = (nowYear || new Date().getFullYear()) + 1;
    const type = VEHICLE_TYPES[v.type] ? v.type : null; if (!type) errors.push('Choose bike or car');
    const name = String(v.name || '').trim().slice(0, 40), make = String(v.make || '').trim().slice(0, 40), model = String(v.model || '').trim().slice(0, 40);
    if (!make) errors.push('Enter the make');
    const yr = v.year === '' || v.year == null ? null : Number(v.year);
    if (yr !== null && !(Number.isInteger(yr) && yr >= 1950 && yr <= maxY)) errors.push('Year must be 1950-' + maxY);
    const odo = v.odo === '' || v.odo == null ? 0 : Number(v.odo); if (!isFinite(odo) || odo < 0 || odo > 2e6) errors.push('Odometer must be 0-2,000,000 km');
    const fuel = type && FUELS[type].includes(v.fuel) ? v.fuel : null; if (type && !fuel) errors.push('Choose a fuel type');
    return { ok: !errors.length, errors, value: { id: v.id, type, name, make, model, year: yr, odo, fuel } };
  }
  // Edit a saved vehicle: validated new fields, but id (and so rides, service items, tyres, fuel log) is kept. enteredOdo = the reading the user typed;
  // the stored base is that minus tracked km, never below 0 (clamped=true when the typed reading was lower than tracked rides).
  function editVehicle(old, fields, trackedKm, nowYear) {
    const r = normalizeVehicle(Object.assign({}, fields), nowYear); if (!r.ok) return r;
    const base = r.value.odo - (trackedKm || 0); const v = Object.assign({}, old, r.value, { id: old.id, odo: Math.max(0, Math.round(base * 10) / 10) }); delete v.auto;
    return { ok: true, errors: [], value: v, clamped: base < 0, minOdo: Math.round(trackedKm || 0) };
  }
  const vehicleName = v => v ? (v.name ? v.name : [v.make, v.model].filter(Boolean).join(' ') || VEHICLE_TYPES[v.type] || 'Vehicle') + (!v.name && v.year ? ' (' + v.year + ')' : '') : 'No vehicle';
  // Odometer of a vehicle = its base reading + tracked rides assigned to it (rides with no vehicleId belong to `defaultId`).
  function vehicleOdo(v, rides, defaultId) {
    if (!v) return 0; const m = (rides || []).filter(r => (r.vehicleId || defaultId) === v.id).reduce((s, r) => s + (isFinite(r.dist) ? r.dist : 0), 0);
    return (Number(v.odo) || 0) + m / 1000;
  }
  // Next due by km and/or date. Returns null if no interval is set.
  function nextDue(item, odo, now) {
    now = now == null ? Date.now() : now; const o = { dueKm: null, dueDate: null, leftKm: null, leftDays: null, by: null, text: '' };
    if (item.kmInterval && item.lastKm != null) { o.dueKm = item.lastKm + item.kmInterval; o.leftKm = o.dueKm - odo; }
    if (item.dayInterval && item.lastDate) { const t = new Date(item.lastDate).getTime(); if (isFinite(t)) { const d = new Date(t + item.dayInterval * 864e5); o.dueDate = d.toISOString().slice(0, 10); o.leftDays = Math.round((d.getTime() - now) / 864e5); } }
    if (o.leftKm === null && o.leftDays === null) return null;
    // which comes first? compare as fraction of interval used
    const fk = o.leftKm === null ? -Infinity : (item.kmInterval - o.leftKm) / item.kmInterval, fd = o.leftDays === null ? -Infinity : (item.dayInterval - o.leftDays) / item.dayInterval;
    o.by = fk >= fd ? 'km' : 'date';
    o.text = o.by === 'km' ? (o.leftKm <= 0 ? Math.round(-o.leftKm) + ' km overdue (was due at ' + Math.round(o.dueKm) + ' km)' : 'due at ' + Math.round(o.dueKm) + ' km, ' + Math.round(o.leftKm) + ' km left')
      : (o.leftDays <= 0 ? -o.leftDays + ' days overdue (was due ' + o.dueDate + ')' : 'due ' + o.dueDate + ', ' + o.leftDays + ' days left');
    const kt = o.leftKm === null ? null : (o.leftKm <= 0 ? Math.round(-o.leftKm) + ' km overdue' : 'at ' + Math.round(o.dueKm) + ' km (' + Math.round(o.leftKm) + ' km left)');
    const dt = o.leftDays === null ? null : (o.leftDays <= 0 ? -o.leftDays + ' days overdue' : 'on ' + o.dueDate + ' (' + o.leftDays + ' days left)');
    o.both = [kt && 'km: ' + kt, dt && 'date: ' + dt].filter(Boolean).join(' · ');
    return o;
  }
  // Mark an item done at an odometer reading and date. Returns a new item (input is not mutated).
  function markDone(item, odo, dateIso, cost) {
    if (!(isFinite(odo) && odo >= 0)) throw new Error('Odometer must be a positive number');
    if (dayNum(dateIso) === null) throw new Error('Date must be YYYY-MM-DD');
    const n = Object.assign({}, item, { lastKm: Math.round(odo), lastDate: dateIso }); if (cost != null && cost !== '' && isFinite(cost)) n.cost = Number(cost); return n;
  }
  // Build editable maintenance items for a vehicle from the suggestion list. Existing names (case-insensitive) are skipped.
  function scheduleItems(vehicle, odo, todayIso, existing) {
    const have = new Set((existing || []).map(i => String(i.name).toLowerCase()));
    return suggestSchedule(vehicle.type, vehicle.fuel).filter(s => !have.has(s.name.toLowerCase())).map(s => ({
      name: s.name, kmInterval: s.kmInterval, monthInterval: s.monthInterval, dayInterval: monthsToDays(s.monthInterval),
      lastKm: Math.round(odo), lastDate: todayIso, vehicleId: vehicle.id, suggested: true }));
  }
  // ---------- v5 stage 1: weather (Open-Meteo), fuel log, stops, backup ----------
  const WX_RAIN = [51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82], WX_STORM = [95, 96, 99];
  function wmoInfo(code) {
    const c = Number(code); const t = { 0: ['Clear sky', 'sun'], 1: ['Mostly clear', 'sun'], 2: ['Partly cloudy', 'pcloud'], 3: ['Overcast', 'cloud'], 45: ['Fog', 'fog'], 48: ['Rime fog', 'fog'],
      51: ['Light drizzle', 'rain'], 53: ['Drizzle', 'rain'], 55: ['Heavy drizzle', 'rain'], 56: ['Freezing drizzle', 'rain'], 57: ['Freezing drizzle', 'rain'], 61: ['Light rain', 'rain'], 63: ['Rain', 'rain'], 65: ['Heavy rain', 'rain'],
      66: ['Freezing rain', 'rain'], 67: ['Freezing rain', 'rain'], 71: ['Light snow', 'snow'], 73: ['Snow', 'snow'], 75: ['Heavy snow', 'snow'], 77: ['Snow grains', 'snow'], 80: ['Rain showers', 'rain'], 81: ['Rain showers', 'rain'], 82: ['Violent showers', 'rain'],
      85: ['Snow showers', 'snow'], 86: ['Snow showers', 'snow'], 95: ['Thunderstorm', 'storm'], 96: ['Thunderstorm, hail', 'storm'], 99: ['Thunderstorm, hail', 'storm'] }[c];
    const base = t ? { label: t[0], kind: t[1] } : { label: 'Unknown', kind: 'cloud' };
    return Object.assign(base, { rain: WX_RAIN.includes(c) || WX_STORM.includes(c), storm: WX_STORM.includes(c) });
  }
  // n points evenly spaced by distance along a [[lat,lon],...] line, always including first and last. km = distance from start.
  function sampleRoute(line, n) {
    const pts = (line || []).filter(p => Array.isArray(p) && isFinite(p[0]) && isFinite(p[1])); if (!pts.length) return [];
    const cum = [0]; for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + haversine({ lat: pts[i - 1][0], lon: pts[i - 1][1] }, { lat: pts[i][0], lon: pts[i][1] }));
    const total = cum[cum.length - 1]; n = Math.max(2, Math.min(12, Math.round(n) || 2)); if (pts.length === 1 || total === 0) return [{ lat: pts[0][0], lon: pts[0][1], km: 0, frac: 0 }];
    const out = []; let j = 1;
    for (let k = 0; k < n; k++) { const d = total * k / (n - 1); while (j < pts.length - 1 && cum[j] < d) j++;
      const seg = cum[j] - cum[j - 1] || 1, f = Math.max(0, Math.min(1, (d - cum[j - 1]) / seg));
      out.push({ lat: +(pts[j - 1][0] + (pts[j][0] - pts[j - 1][0]) * f).toFixed(4), lon: +(pts[j - 1][1] + (pts[j][1] - pts[j - 1][1]) * f).toFixed(4), km: +(d / 1000).toFixed(1), frac: k / (n - 1) }); }
    return out;
  }
  const sampleCount = distM => Math.max(2, Math.min(8, Math.ceil((distM || 0) / 40000) + 1));
  const wxRouteUrl = pts => 'https://api.open-meteo.com/v1/forecast?latitude=' + pts.map(p => (+p.lat).toFixed(3)).join(',') + '&longitude=' + pts.map(p => (+p.lon).toFixed(3)).join(',') +
    '&current=temperature_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m,wind_gusts_10m&hourly=precipitation_probability,precipitation,weather_code&forecast_hours=12&timezone=auto';
  const wxDestUrl = p => 'https://api.open-meteo.com/v1/forecast?latitude=' + (+p.lat).toFixed(3) + '&longitude=' + (+p.lon).toFixed(3) +
    '&current=temperature_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m,wind_gusts_10m&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum&forecast_days=3&timezone=auto';
  // Open-Meteo returns an object for one location and an array for several. Always returns an array of locations; throws on an error body.
  function parseOpenMeteo(j) {
    if (j && j.error) throw new Error(j.reason || 'weather service error');
    const arr = Array.isArray(j) ? j : j && typeof j === 'object' ? [j] : null; if (!arr || !arr.length) throw new Error('unexpected weather response');
    return arr.map(o => { if (!o || !o.current) throw new Error('weather response has no current conditions'); const c = o.current;
      return { temp: c.temperature_2m, feels: c.apparent_temperature, precip: c.precipitation || 0, code: c.weather_code, wind: c.wind_speed_10m, gust: c.wind_gusts_10m, time: c.time,
        hourly: o.hourly ? (o.hourly.time || []).map((t, i) => ({ time: t, prob: o.hourly.precipitation_probability ? o.hourly.precipitation_probability[i] : null, mm: o.hourly.precipitation ? o.hourly.precipitation[i] : 0, code: o.hourly.weather_code ? o.hourly.weather_code[i] : null })) : [],
        daily: o.daily ? (o.daily.time || []).map((t, i) => ({ date: t, code: o.daily.weather_code[i], max: o.daily.temperature_2m_max[i], min: o.daily.temperature_2m_min[i], prob: o.daily.precipitation_probability_max ? o.daily.precipitation_probability_max[i] : null, mm: o.daily.precipitation_sum ? o.daily.precipitation_sum[i] : 0 })) : [] }; });
  }
  // Rain / storm / gust alerts per sample. samples[i] = {km, frac}; wx[i] = parseOpenMeteo location; durSec = route duration (departure assumed now).
  function rainAlerts(samples, wx, durSec) {
    const out = [];
    samples.forEach((s, i) => { const w = wx[i]; if (!w) return; const etaMin = Math.round((durSec || 0) * (s.frac || 0) / 60);
      const info = wmoInfo(w.code); let level = null, why = '';
      if (info.storm) { level = 'storm'; why = 'thunderstorm now'; } else if (info.rain || w.precip >= 0.1) { level = 'rain'; why = 'raining now'; }
      if (!level && w.hourly && w.hourly.length) { const h = w.hourly[Math.min(w.hourly.length - 1, Math.max(0, Math.round(etaMin / 60)))];
        if (h) { const hi = wmoInfo(h.code); if (hi.storm) { level = 'storm'; why = 'thunderstorm expected'; } else if ((h.prob != null && h.prob >= 50) || h.mm >= 0.5 || hi.rain) { level = 'rain'; why = 'rain expected' + (h.prob != null ? ' (' + h.prob + '%)' : ''); } } }
      if (!level && w.gust >= 50) { level = 'wind'; why = 'strong gusts ' + Math.round(w.gust) + ' km/h'; }
      if (level) out.push({ i, km: s.km, etaMin, level, why }); });
    return out;
  }
  function routeWeatherSummary(alerts) {
    if (!alerts.length) return { level: 'clear', text: 'No rain or strong wind expected along the route in the next 12 h forecast.' };
    const a = alerts.find(x => x.level === 'storm') || alerts.find(x => x.level === 'rain') || alerts[0];
    return { level: a.level, text: (a.level === 'storm' ? 'Thunderstorm risk' : a.level === 'rain' ? 'Rain' : 'Strong wind') + ' near km ' + a.km + (a.etaMin ? ' (about ' + a.etaMin + ' min from now)' : '') + ': ' + a.why + '. ' + alerts.length + ' of the sample points affected.' };
  }
  const wxKey = u => String(u).replace(/^https:\/\/api\.open-meteo\.com\/v1\/forecast\?/, '');
  const wxFresh = (e, now, ttlMs) => !!(e && e.t && now - e.t < (ttlMs == null ? 20 * 60000 : ttlMs));
  const fmtWxAge = (e, now) => { if (!e || !e.t) return ''; const m = Math.max(0, Math.round((now - e.t) / 60000)); return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : Math.round(m / 60) + ' h ago'; };

  // Fuel log. Entry: {id, vehicleId, date:'YYYY-MM-DD', odo, litres, total (₹), full:boolean, place?}
  function validateFuel(e) {
    const errs = [], n = x => (x === '' || x == null) ? NaN : Number(x);
    if (dayNum(e.date) === null) errs.push('Date must be YYYY-MM-DD');
    if (!(n(e.odo) >= 0)) errs.push('Odometer must be a number, 0 or more');
    if (!(n(e.litres) > 0 && n(e.litres) < 1000)) errs.push('Litres must be more than 0');
    if (!(n(e.total) >= 0 && isFinite(n(e.total)))) errs.push('Amount in ₹ must be 0 or more');
    return errs;
  }
  function normalizeFuel(e) { return { id: e.id, vehicleId: e.vehicleId, date: e.date, odo: Math.round(Number(e.odo)), litres: +Number(e.litres).toFixed(2), total: +Number(e.total).toFixed(2), full: e.full !== false, place: String(e.place || '').slice(0, 60) }; }
  // Full-to-full method: mileage between two consecutive FULL fills = km driven / litres bought in fills after the first one up to and including the second.
  function fuelStats(entries) {
    const es = (entries || []).filter(e => isFinite(e.odo) && e.litres > 0).slice().sort((a, b) => a.odo - b.odo || (dayNum(a.date) - dayNum(b.date)));
    const segs = []; let lastFull = null, litres = 0, cost = 0;
    es.forEach(e => { if (lastFull) { litres += e.litres; cost += e.total || 0; }
      if (e.full) { if (lastFull && e.odo > lastFull.odo && litres > 0) { const km = e.odo - lastFull.odo; segs.push({ from: lastFull.odo, to: e.odo, km, litres: +litres.toFixed(2), cost: +cost.toFixed(2), kmpl: +(km / litres).toFixed(2), perKm: +(cost / km).toFixed(2), date: e.date }); } lastFull = e; litres = 0; cost = 0; } });
    const sumKm = segs.reduce((s, x) => s + x.km, 0), sumL = segs.reduce((s, x) => s + x.litres, 0), sumC = segs.reduce((s, x) => s + x.cost, 0);
    return { entries: es, segs, avgKmpl: sumL ? +(sumKm / sumL).toFixed(1) : null, perKm: sumKm ? +(sumC / sumKm).toFixed(2) : null, last: segs[segs.length - 1] || null,
      totalSpent: +es.reduce((s, x) => s + (x.total || 0), 0).toFixed(2), totalLitres: +es.reduce((s, x) => s + x.litres, 0).toFixed(1), count: es.length };
  }
  // Stops: a run of GPS points staying within radiusM of the first one for >= minSec. (Fixes are filtered when stationary, so a time gap with no movement counts.)
  function detectStops(points, minSec, radiusM) {
    minSec = minSec || 180; radiusM = radiusM || 100; const p = points || [], out = []; let i = 0;
    while (i < p.length - 1) { let j = i + 1; while (j < p.length && haversine(p[i], p[j]) <= radiusM) j++;
      if (j > i + 1 && (p[j - 1].t - p[i].t) / 1000 >= minSec) { out.push({ lat: p[i].lat, lon: p[i].lon, t: p[i].t, durSec: Math.round((p[j - 1].t - p[i].t) / 1000), kind: null }); i = j; } else i++; }
    return out;
  }
  const STOP_KINDS = ['fuel', 'food', 'rest', 'photo', 'mechanic', 'other'];

  // Backup file: {app, schema, exportedAt, data:{rides, maint, kv}}. Photos are inlined as data URLs by the app before calling this.
  const BACKUP_KV_SKIP = ['wx', 'demo'];
  function buildBackup(data, now, appVersion) {
    const kv = {}; Object.keys(data.kv || {}).forEach(k => { if (!BACKUP_KV_SKIP.includes(k)) kv[k] = data.kv[k]; });
    return { app: 'riderkit', schema: 1, appVersion: appVersion || 'v5', exportedAt: new Date(now == null ? Date.now() : now).toISOString(), data: { rides: data.rides || [], maint: data.maint || [], kv } };
  }
  function validateBackup(o) {
    const errors = []; if (!o || typeof o !== 'object' || Array.isArray(o)) return { ok: false, errors: ['Not a RiderKit backup (not a JSON object)'], counts: null };
    if (o.app !== 'riderkit') errors.push('Not a RiderKit backup (missing app marker)');
    if (o.schema !== 1) errors.push('Unsupported backup version: ' + o.schema);
    const d = o.data; if (!d || typeof d !== 'object') errors.push('Backup has no data section');
    else { if (!Array.isArray(d.rides)) errors.push('rides must be a list'); if (!Array.isArray(d.maint)) errors.push('maint must be a list'); if (!d.kv || typeof d.kv !== 'object' || Array.isArray(d.kv)) errors.push('kv must be an object');
      if (Array.isArray(d.rides) && d.rides.some(r => !r || typeof r !== 'object' || !isFinite(r.start))) errors.push('A ride is missing its start time');
      if (Array.isArray(d.maint) && d.maint.some(r => !r || typeof r !== 'object')) errors.push('A service item is malformed'); }
    const fuel = d && d.kv && Array.isArray(d.kv.fuel) ? d.kv.fuel.length : 0;
    return { ok: !errors.length, errors, counts: errors.length ? null : { rides: d.rides.length, maint: d.maint.length, fuel, vehicles: Array.isArray(d.kv.vehicles) ? d.kv.vehicles.length : 0, photos: d.rides.reduce((s, r) => s + (Array.isArray(r.photos) ? r.photos.length : 0), 0) } };
  }
  // ---------- group breakdown / SOS alerts ----------
  const ALERT_TYPES = ['bike', 'car', 'puncture', 'accident', 'sos'];
  const ALERT_LABEL = { bike: 'Bike breakdown', car: 'Car breakdown', puncture: 'Puncture', accident: 'Accident', sos: 'SOS - needs help' };
  const alertLabel = t => ALERT_LABEL[t] || 'Alert';
  // Active alerts from a group snapshot's members. Others first by newest; each has distance from `me` ({lat,lon}) when both positions are known.
  function alertRows(members, myId, me) {
    return (members || []).filter(m => m && m.alert && ALERT_TYPES.includes(m.alert.type)).map(m => { const a = m.alert, has = a.lat != null && a.lng != null;
      return { id: m.id, name: m.name, type: a.type, label: alertLabel(a.type), at: a.at, lat: has ? a.lat : null, lng: has ? a.lng : null, mine: m.id === myId, color: m.color,
        distM: has && me && isFinite(me.lat) && isFinite(me.lon) ? haversine(me, { lat: a.lat, lon: a.lng }) : null }; })
      .sort((x, y) => (x.mine - y.mine) || (y.at - x.at));
  }
  // Which alerts in `rows` are new since `seen` (a Set of 'id@at' keys)? Returns the new rows (not mine) and updates the set.
  function freshAlerts(rows, seen) { const out = []; const keys = new Set(); rows.forEach(r => { const k = r.id + '@' + r.at; keys.add(k); if (!seen.has(k) && !r.mine) out.push(r); }); seen.clear(); keys.forEach(k => seen.add(k)); return out; }
  const alertNavLink = (a, origin) => a && a.lat != null ? gmapsLink({ lat: a.lat, lng: a.lng }, origin) : null;
  // ---- feedback (no location is ever included) ----
  const FB_TYPES = ['bug', 'idea', 'other'];
  function buildFeedback(type, message, contact, env) { env = env || {};
    const msg = String(message || '').trim(); if (!FB_TYPES.includes(type)) return { error: 'Pick a type' }; if (msg.length < 5) return { error: 'Please write at least 5 characters' }; if (msg.length > 2000) return { error: 'Message is too long (max 2000 characters)' };
    return { value: { type, message: msg, contact: String(contact || '').trim().slice(0, 200), meta: { ver: String(env.ver || ''), ua: String(env.ua || '').slice(0, 300), platform: String(env.platform || ''), lang: String(env.lang || ''), screen: String(env.screen || ''), standalone: !!env.standalone, online: !!env.online } } }; }
  const fbQueueAdd = (q, item, cap = 20) => { const a = (Array.isArray(q) ? q : []).concat([item]); return a.slice(-cap); };
  const fbShouldRetry = status => status === 0 || status === 429 || status >= 500; // network error / throttled / server trouble -> keep queued; other 4xx -> drop
  const api = { buildFeedback, fbQueueAdd, fbShouldRetry, VEHICLE_TYPES, FUELS, suggestSchedule, normalizeVehicle, editVehicle, vehicleName, vehicleOdo, nextDue, markDone, scheduleItems, monthsToDays, daysToMonths, rideStats, gridCells, cellOf, thin, nextService, tyreStatus, TYRE_GUIDE, demoData, CELL_DEG, groupFlags, fmtAgo, fmtDist, normCode, codeFromSearch, gmapsLink, stepText, parseRoute, DOC_TYPES, docStatus, docAlerts, dayNum, toGPX, parseGPX, DEFAULT_CONTACTS, telLink, shareLocationLinks, haversine, totalDistance, acceptFix, kmh, fmtDuration, fmtKm, fmtINR, CrashDetector, alertLinks, maintStatus, wmoInfo, sampleRoute, sampleCount, wxRouteUrl, wxDestUrl, parseOpenMeteo, rainAlerts, routeWeatherSummary, wxKey, wxFresh, fmtWxAge, validateFuel, normalizeFuel, fuelStats, detectStops, STOP_KINDS, buildBackup, validateBackup, BACKUP_KV_SKIP, ALERT_TYPES, ALERT_LABEL, alertLabel, alertRows, freshAlerts, alertNavLink };
  if (typeof module !== 'undefined') module.exports = api; else root.Core = api;
})(typeof self !== 'undefined' ? self : this);
