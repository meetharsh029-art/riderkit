// RiderKit extra pure logic (stages 1-7). Browser: window.Extra. Node: module.exports. No DOM, no network.
(function (root) {
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
      shown[key] = today; show.push({ key, title: 'RiderKit: ' + r.title, body: r.title + ' ' + phrase(days) + '.', url: './#' + (r.kind === 'doc' ? 'docs' : 'service'), tag: 'rk-' + r.id }); }
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

  const api = { PIN_TYPES, bboxAround, pinAge, pinLeft, inBox, mergePinCache, newDeviceId, isoOf, dayNum, todayNum, addDays, buildReminders, stageFor, phrase, localPlan, urlB64ToBytes, TYRE_AGE_DAYS, TYRE_PRESSURE_DAYS };
  if (typeof module !== 'undefined') module.exports = api; else root.Extra = api;
})(typeof self !== 'undefined' ? self : this);
