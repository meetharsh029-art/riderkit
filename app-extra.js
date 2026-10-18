// RiderKit extras UI (stages 1-7). Loaded after app.js; talks to app.js through window.__rkApp (see end of app.js).
(() => {
'use strict';
const $ = id => document.getElementById(id), X = window.Extra, A = window.__rkApp, K = window.__rk;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const API = (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) ? 'https://riderkit.onrender.com' : '';
const jfetch = async (method, path, body, tmo = 12000) => { const r = await fetch(API + path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout ? AbortSignal.timeout(tmo) : undefined });
  let j = {}; try { j = await r.json(); } catch {} if (!r.ok) { const e = new Error(j.error || 'HTTP ' + r.status); e.status = r.status; throw e; } return j; };
const toast = t => { const el = $('xToast'); if (!el) return; el.textContent = t; el.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => el.hidden = true, 4000); };

// ===== Stage 1: reminders =====
const supportsPush = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
async function collectReminders() {
  const docsSaved = (await K.kvGet('docs')) || {}; const docs = Object.keys(Core.DOC_TYPES).map(k => ({ type: k, name: Core.DOC_TYPES[k], expiry: docsSaved[k]?.expiry || '' }));
  const st = await A.vehicleState(); const reminders = [];
  const all = await K.getAll('maint'), vs = st.vs, tyresAll = (await K.kvGet('tyres')) || {};
  for (const v of vs) { const items = all.filter(i => (i.vehicleId || st.defId) === v.id); const r = X.buildReminders({ docs: v === vs[0] ? docs : [], items, tyres: tyresAll[v.id] || {} });
    for (const x of r) { if (vs.length > 1 && x.kind !== 'doc') { x.id = x.id + '-' + v.id; x.title = (Core.vehicleName ? Core.vehicleName(v) : 'Vehicle') + ': ' + x.title; } reminders.push(x); } }
  return reminders;
}
async function pushSubState() { try { const reg = await navigator.serviceWorker.ready; return await reg.pushManager.getSubscription(); } catch { return null; } }
async function syncReminders(sub) { sub = sub || await pushSubState(); if (!sub) return false;
  try { await jfetch('POST', '/api/push/sync', { subscription: sub.toJSON(), tz: -new Date().getTimezoneOffset(), reminders: await collectReminders() }); return true; } catch { return false; } }
async function localNotify() { // fallback + belt and braces: when the app is opened, show due reminders (once per stage) as system notifications if permitted
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  let shown = {}; try { shown = JSON.parse(localStorage.getItem('rk-rem-shown') || '{}'); } catch {}
  const plan = X.localPlan(await collectReminders(), shown, Date.now()); try { localStorage.setItem('rk-rem-shown', JSON.stringify(plan.shown)); } catch {}
  if (!plan.show.length) return; const reg = await navigator.serviceWorker.ready.catch(() => null);
  for (const n of plan.show) { try { reg ? await reg.showNotification(n.title, { body: n.body, tag: n.tag, data: { url: n.url }, icon: 'icons/icon-192.png' }) : new Notification(n.title, { body: n.body }); } catch {} } }
async function renderRem() {
  const el = $('remBox'); if (!el) return; const list = await collectReminders(); const sup = supportsPush(), perm = 'Notification' in window ? Notification.permission : 'unsupported';
  const sub = sup ? await pushSubState() : null; const today = X.todayNum();
  const up = list.map(r => ({ ...r, days: X.dayNum(r.due) - today })).filter(r => r.days <= 60).sort((a, b) => a.days - b.days).slice(0, 6);
  let status = !('Notification' in window) ? 'This browser cannot show notifications. Reminders still appear inside RiderKit (banner + Home).'
    : perm === 'denied' ? 'Notifications are blocked for this site in your browser settings. Reminders still appear inside RiderKit.'
    : sub ? 'On. Push reminders are sent at 30, 7 and 1 days before, on the day, and once when overdue (between 8:00 and 21:00).'
    : perm === 'granted' ? 'Allowed, but push is not set up (' + (sup ? 'tap Turn on' : 'push is not supported here') + '). Due reminders show when you open RiderKit.' : 'Off.';
  el.innerHTML = `<p id="remStatus">${esc(status)}</p>` + (up.length ? '<ul class="remlist">' + up.map(r => `<li><b>${esc(r.title)}</b> &ndash; ${esc(X.phrase(r.days).replace(/^is /, '').replace(/^was /, ''))}</li>`).join('') + '</ul>' : '<p class="hint">No dated reminders yet. Add expiry dates to documents or last-done dates to service items.</p>')
    + `<div class="row">${sub ? '<button id="remOff" class="small">Turn off</button><button id="remTest" class="small">Send test</button>' : (perm === 'denied' || !('Notification' in window) ? '' : '<button id="remOn" class="primary small">Turn on reminders</button>')}</div>`;
  if ($('remOn')) $('remOn').onclick = enablePush; if ($('remOff')) $('remOff').onclick = disablePush; if ($('remTest')) $('remTest').onclick = testPush;
}
async function enablePush() {
  const msg = t => { const s = $('remStatus'); if (s) s.textContent = t; };
  try {
    const perm = await Notification.requestPermission(); if (perm !== 'granted') { msg('Permission was not granted, so no notifications will be shown.'); return; }
    if (!supportsPush()) { await localNotify(); await renderRem(); return; }
    const { key } = await jfetch('GET', '/api/push/key'); const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription(); if (sub) { const cur = new Uint8Array(sub.options.applicationServerKey || []); const want = X.urlB64ToBytes(key); if (cur.length !== want.length || cur.some((v, i) => v !== want[i])) { await sub.unsubscribe(); sub = null; } }
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: X.urlB64ToBytes(key) });
    if (!(await syncReminders(sub))) throw new Error('could not reach the RiderKit server');
    try { localStorage.setItem('rk-push', '1'); } catch {} toast('Reminders on'); await renderRem();
  } catch (e) { await renderRem(); const s = $('remStatus'); if (s) s.textContent = 'Could not turn on push (' + e.message + '). Reminders still appear inside RiderKit and as notifications when you open it.'; }
}
async function disablePush() { const sub = await pushSubState(); if (sub) { try { await jfetch('POST', '/api/push/unsubscribe', { endpoint: sub.endpoint }); } catch {} try { await sub.unsubscribe(); } catch {} } try { localStorage.removeItem('rk-push'); } catch {} await renderRem(); }
async function testPush() { const sub = await pushSubState(); if (!sub) return; await syncReminders(sub); try { const r = await jfetch('POST', '/api/push/test', { endpoint: sub.endpoint }); toast(r.ok ? 'Test sent. It should arrive in a moment.' : 'The push service did not accept it (' + r.result + ').'); } catch (e) { toast(e.message); } }
const TABS = ['docs', 'service', 'home', 'ride', 'log', 'group'];
const routeHash = () => { const h = (location.hash || '').slice(1); if (TABS.includes(h)) { A.showTab(h); history.replaceState(null, '', location.pathname + location.search); } };
window.addEventListener('hashchange', routeHash); setTimeout(routeHash, 300);
window.__rkX = { collectReminders, syncReminders, renderRem, localNotify };
function onTab(name) { if (name === 'docs') renderRem(); }
window.__rkOnTab = (window.__rkOnTab || []); window.__rkOnTab.push(onTab);

// resync reminders after any data change worth it (cheap, debounced) and on every open
let syncT; const resyncSoon = () => { clearTimeout(syncT); syncT = setTimeout(() => { if (localStorage.getItem('rk-push')) syncReminders(); }, 2500); };
document.addEventListener('visibilitychange', () => { if (!document.hidden) resyncSoon(); });
['click', 'change'].forEach(ev => document.addEventListener(ev, e => { if (e.target.closest && e.target.closest('.dxSave,#maintList,#vSave,#tyreForm,[data-act]')) resyncSoon(); }, true));
setTimeout(async () => { try { await localNotify(); if (localStorage.getItem('rk-push')) await syncReminders(); } catch {} }, 1500);

// ===== Stage 2: hazard + place pins =====
const PN = { map: null, layer: null, sel: null, types: JSON.parse(localStorage.getItem('rk-pin-types') || 'null') || Object.keys(X.PIN_TYPES), loadT: null, byId: {} };
const devId = () => { let d = localStorage.getItem('rk-did'); if (!/^[a-f0-9]{16,64}$/.test(d || '')) { d = X.newDeviceId(); localStorage.setItem('rk-did', d); } return d; };
const pinFetch = async (method, path, body) => { const r = await fetch(API + path, { method, headers: { 'content-type': 'application/json', 'x-device-id': devId() }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout ? AbortSignal.timeout(12000) : undefined }); let j = {}; try { j = await r.json(); } catch {} if (!r.ok) throw Object.assign(new Error(j.error || 'HTTP ' + r.status), { status: r.status }); return j; };
const pinMsg = t => { $('pinMsg').textContent = t; };
function pinInit() {
  if (PN.map) { setTimeout(() => PN.map.invalidateSize(), 60); return; }
  $('pinChips').innerHTML = Object.entries(X.PIN_TYPES).map(([k, v]) => `<label><input type="checkbox" data-pt="${k}" ${PN.types.includes(k) ? 'checked' : ''}>${esc(v.label)}</label>`).join('');
  $('pinType').innerHTML = Object.entries(X.PIN_TYPES).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join('');
  $('pinChips').onchange = () => { PN.types = [...$('pinChips').querySelectorAll('input:checked')].map(i => i.dataset.pt); localStorage.setItem('rk-pin-types', JSON.stringify(PN.types)); pinDraw(); };
  let c = [22.5, 78.9], z = 5; try { const lp = JSON.parse(localStorage.getItem('rk-lastpos') || 'null'); if (lp) { c = [lp.lat, lp.lng]; z = 13; } } catch {}
  PN.map = L.map('pinMap', { zoomControl: true }).setView(c, z); L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }).addTo(PN.map);
  PN.layer = L.layerGroup().addTo(PN.map); PN.map.on('moveend', () => { clearTimeout(PN.loadT); PN.loadT = setTimeout(pinLoad, 700); });
  $('pinRefresh').onclick = () => pinLoad(true); $('pinLocate').onclick = () => locate().then(p => { PN.map.setView([p.lat, p.lng], 14); }).catch(e => pinMsg(e.message));
  $('pinAddMe').onclick = async () => { try { const p = await locate(); await pinAdd(p.lat, p.lng); } catch (e) { $('pinAddMsg').textContent = e.message; } };
  $('pinAddMap').onclick = () => { const c = PN.map.getCenter(); pinAdd(c.lat, c.lng).catch(e => { $('pinAddMsg').textContent = e.message; }); };
  setTimeout(() => { PN.map.invalidateSize(); pinLoad(); }, 200);
}
function locate() { return new Promise((ok, bad) => { if (!navigator.geolocation) return bad(new Error('Location is not available on this device')); navigator.geolocation.getCurrentPosition(p => { const o = { lat: p.coords.latitude, lng: p.coords.longitude }; try { localStorage.setItem('rk-lastpos', JSON.stringify(o)); } catch {} ok(o); }, e => bad(new Error('Could not get your location: ' + e.message)), { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 }); }); }
async function pinLoad(force) {
  const b = PN.map.getBounds(), bb = [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()];
  if (bb[2] - bb[0] > 3 || bb[3] - bb[1] > 3) { pinMsg('Zoom in to see pins (the map area is too large).'); PN.layer.clearLayers(); return; }
  try { const j = await pinFetch('GET', '/api/pins?bbox=' + bb.map(n => n.toFixed(4)).join(',')); PN.byId = {}; j.pins.forEach(p => PN.byId[p.id] = p);
    const cache = (await K.kvGet('pinsCache')) || {}; await K.kvSet('pinsCache', X.mergePinCache(cache, j.pins, Date.now(), 400)); pinMsg(j.pins.length + ' pin' + (j.pins.length === 1 ? '' : 's') + ' in this area.'); }
  catch (e) { const cache = (await K.kvGet('pinsCache')) || {}; PN.byId = {}; Object.values(cache).filter(p => p.exp > Date.now() && X.inBox(p, bb)).forEach(p => PN.byId[p.id] = p);
    pinMsg((e.status === 429 ? e.message : 'Offline or server unavailable') + ': showing ' + Object.keys(PN.byId).length + ' saved pins.'); }
  pinDraw();
}
function pinDraw() { PN.layer.clearLayers(); Object.values(PN.byId).filter(p => PN.types.includes(p.type)).forEach(p => { const T = X.PIN_TYPES[p.type]; if (!T) return;
  L.marker([p.lat, p.lng], { icon: L.divIcon({ className: '', iconSize: [26, 26], iconAnchor: [13, 13], html: `<div class="pinbtn" style="background:${T.color}" aria-label="${esc(T.label)}">${T.short}</div>` }), title: T.label }).on('click', () => pinSelect(p.id)).addTo(PN.layer); }); if (PN.sel && !PN.byId[PN.sel]) { PN.sel = null; $('pinSel').hidden = true; } }
function pinSelect(id) { const p = PN.byId[id]; if (!p) return; PN.sel = id; const T = X.PIN_TYPES[p.type]; const el = $('pinSel'); el.hidden = false; const mine = (JSON.parse(localStorage.getItem('rk-pin-votes') || '{}'))[id];
  el.innerHTML = `<h3>${esc(T.label)}</h3>${p.note ? `<p>${esc(p.note)}</p>` : ''}<p class="hint">Added ${esc(X.pinAge(p.at))} &middot; last confirmed ${esc(X.pinAge(p.seen || p.at))} &middot; ${esc(X.pinLeft(p.exp))}<br>${p.up} still there &middot; ${p.down} gone</p>
  <div class="row"><button class="primary small" data-pv="up" ${mine === 'up' ? 'disabled' : ''}>Still there</button><button class="small" data-pv="down" ${mine === 'down' ? 'disabled' : ''}>Gone / wrong</button><button class="small" data-pv="report">Report</button><a class="btn small" target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}">Navigate</a></div><p id="pinSelMsg" class="hint" role="status"></p>`;
  el.querySelectorAll('[data-pv]').forEach(b => b.onclick = () => pinAct(p.id, b.dataset.pv)); }
async function pinAct(id, act) { const m = t => { const e = $('pinSelMsg'); if (e) e.textContent = t; };
  try { if (act === 'report') { if (!confirm('Report this pin as spam, abusive or wrong? Three reports hide it.')) return; await pinFetch('POST', '/api/pins/report', { id }); m('Thanks, reported.'); return; }
    const r = await pinFetch('POST', '/api/pins/vote', { id, dir: act }); const v = JSON.parse(localStorage.getItem('rk-pin-votes') || '{}'); v[id] = act; localStorage.setItem('rk-pin-votes', JSON.stringify(v).slice(0, 20000));
    if (r.removed) { delete PN.byId[id]; PN.sel = null; $('pinSel').hidden = true; pinDraw(); pinMsg('Removed: enough riders said it is gone.'); } else { PN.byId[id] = r.pin; pinSelect(id); } }
  catch (e) { m(e.message); } }
async function pinAdd(lat, lng) { const type = $('pinType').value; $('pinAddMsg').textContent = 'Adding...';
  const r = await pinFetch('POST', '/api/pins', { type, lat, lng, note: $('pinNote').value }); $('pinNote').value = ''; PN.byId[r.pin.id] = r.pin; if (!PN.types.includes(type)) PN.types.push(type); pinDraw(); PN.map.setView([r.pin.lat, r.pin.lng], Math.max(PN.map.getZoom(), 14));
  $('pinAddMsg').textContent = r.merged ? 'A matching pin was already here, so your add counted as "still there".' : 'Pin added. It stays for ' + (X.PIN_TYPES[type].hazard ? '14 days' : 'about 6 months') + ' unless riders confirm or remove it.'; pinSelect(r.pin.id); }
window.__rkPins = PN;
window.__rkOnTab.push(name => { if (name === 'pins') pinInit(); });

// ===== Stage 3: auto re-route + voice turn prompts (group route; Web Speech API speechSynthesis) =====
const NV = { nav: null, key: '', st: X.newNavState(), voice: localStorage.getItem('rk-nav-voice') !== '0', lastSay: 0, rerouting: false, spoken: [] };
const canSpeak = () => 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined';
function say(text) { NV.spoken.push(text); if (NV.spoken.length > 50) NV.spoken.shift(); window.__rkLastSpeech = text; if (!NV.voice || !canSpeak()) return false;
  try { const u = new SpeechSynthesisUtterance(text); u.lang = 'en-IN'; u.rate = 1; u.volume = 1; speechSynthesis.speak(u); return true; } catch { return false; } }
function navInit() { const cb = $('navVoice'); if (!cb) return; cb.checked = NV.voice && canSpeak(); cb.disabled = !canSpeak();
  $('navNote').textContent = canSpeak() ? 'Spoken prompts use your phone\'s text-to-speech and need the screen on and RiderKit open. Auto re-route asks the OSRM demo server for a new route when you leave the route (at most once per 25 s, 6 per 10 min).' : 'This browser has no speech synthesis, so turn prompts are shown on screen only.';
  cb.onchange = () => { NV.voice = cb.checked; localStorage.setItem('rk-nav-voice', cb.checked ? '1' : '0'); }; $('navTest').onclick = () => { const ok = say('Voice prompts are on. In 200 metres, turn left.'); if (!ok) toast(canSpeak() ? 'Voice prompts are switched off.' : 'This device cannot speak prompts.'); }; }
function navRender(o) { const card = $('navCard'), G = A.G; if (!card) return; if (!NV.nav || !G.sess) { card.hidden = true; return; } card.hidden = false;
  let main = '', sub = ''; if (NV.rerouting) { main = 'Re-routing...'; sub = 'You left the route.'; } else if (o && o.arrived) { main = 'You have arrived'; } else if (o && o.off) { main = 'Off route'; sub = 'Looking for a new route. Use "Route from my location" if this persists.'; }
  else if (o && o.next) { main = (o.next.dist >= 1000 ? (o.next.dist / 1000).toFixed(1) + ' km' : Math.round(o.next.dist / 10) * 10 + ' m') + ': ' + o.next.text; sub = o.remaining != null ? Core.fmtDist(o.remaining) + ' to go' : ''; }
  card.classList.toggle('off', !!(NV.rerouting || (o && o.off))); $('navBanner').textContent = main; $('navSub').textContent = sub; }
async function onFix(fix) { const G = A.G; if (!fix || !G.sess || !G.route) { if (NV.nav) { NV.nav = null; NV.key = ''; } navRender(); return; }
  const key = X.navKeyOf(G.route); if (key !== NV.key) { NV.nav = X.buildNav(G.route); NV.key = key; NV.st = X.newNavState(); NV.rerouting = false; }
  const o = X.navUpdate(NV.nav, NV.st, { lat: fix.lat, lng: fix.lng, acc: fix.acc, speed: fix.speed }, Date.now()); window.__rkNav = o;
  o.say.forEach(t => say(t)); navRender(o);
  if (o.reroute && !NV.rerouting) { NV.rerouting = true; say('Re-routing'); navRender(o); try { await A.maybeRoute(true); } catch {} setTimeout(() => { NV.rerouting = false; }, 4000); } }
setInterval(() => { const G = A.G; if (G.sess && G.route && G.fix && X.navKeyOf(G.route) !== NV.key) onFix(G.fix); }, 1500); // new route (set destination / re-route): initialise without waiting for the next GPS fix
window.__rkOnFix = onFix; window.__rkNavState = NV;
window.__rkOnTab.push(name => { if (name === 'group') navInit(); }); setTimeout(navInit, 500);
//__STAGES__
})();
