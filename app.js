(() => {
const $ = id => document.getElementById(id);
const C = Core;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// ---------- IndexedDB ----------
let _db;
function db() {
  if (_db) return _db;
  _db = new Promise((res, rej) => {
    const r = indexedDB.open('riderkit', 1);
    r.onupgradeneeded = () => { const d = r.result;
      d.createObjectStore('rides', { keyPath: 'id', autoIncrement: true });
      d.createObjectStore('maint', { keyPath: 'id', autoIncrement: true });
      d.createObjectStore('kv'); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  return _db;
}
async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((res, rej) => { const t = d.transaction(store, mode); const rq = fn(t.objectStore(store));
    t.oncomplete = () => res(rq && rq.result); t.onerror = () => rej(t.error); });
}
const getAll = s => tx(s, 'readonly', o => o.getAll());
const put = (s, v, k) => tx(s, 'readwrite', o => o.put(v, k));
const del = (s, k) => tx(s, 'readwrite', o => o.delete(k));
const kvGet = k => tx('kv', 'readonly', o => o.get(k));
const kvSet = (k, v) => put('kv', v, k);
window.__rk = { getAll, put, del, kvGet, kvSet }; // exposed for tests/debug

// ---------- icons + tabs ----------
const ico = (n, c) => `<svg class="ic ${c || ''}" aria-hidden="true"><use href="#i-${n}"/></svg>`;
const MORE = ['docs', 'help', 'group', 'me'];
let curTab = 'home';
function showTab(name) {
  curTab = name;
  document.querySelectorAll('nav [data-tab]').forEach(x => { const on = x.dataset.tab === name; x.classList.toggle('on', on); if (on) x.setAttribute('aria-current', 'page'); else x.removeAttribute('aria-current'); });
  $('navMore').classList.toggle('on', MORE.includes(name));
  document.querySelectorAll('#moreSheet [data-tab]').forEach(x => x.classList.toggle('on', x.dataset.tab === name));
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.id === 'tab-' + name));
  closeMore(); window.scrollTo({ top: 0 });
  if (name === 'home') renderHome();
  if (name === 'ride') setTimeout(() => map.invalidateSize(), 50);
  if (name === 'group' && G.map) setTimeout(() => G.map.invalidateSize(), 50);
  if (name === 'log') renderRides();
  if (name === 'service') renderMaint();
  if (name === 'docs') renderDocs();
  if (name === 'help') renderContacts();
}
function closeMore() { $('moreSheet').hidden = true; $('navMore').setAttribute('aria-expanded', 'false'); }
document.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => showTab(b.dataset.tab));
document.querySelectorAll('[data-go]').forEach(b => b.onclick = () => showTab(b.dataset.go));
$('navMore').onclick = e => { e.stopPropagation(); const open = $('moreSheet').hidden; $('moreSheet').hidden = !open; $('navMore').setAttribute('aria-expanded', String(open)); };
document.addEventListener('click', e => { if (!$('moreSheet').hidden && !e.target.closest('#moreSheet')) closeMore(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeMore(); });
const netUpd = () => $('net').textContent = navigator.onLine ? '' : 'offline';
addEventListener('online', netUpd); addEventListener('offline', netUpd); netUpd();

// ---------- map ----------
const map = L.map('map', { zoomControl: false }).setView([20.5937, 78.9629], 5); // India
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap contributors' }).addTo(map);
const line = L.polyline([], { color: '#22e6ff', weight: 5, className: 'glow' }).addTo(map);
let marker = null;

// ---------- ride tracking ----------
let ride = null, watchId = null, timer = null, wake = null, lastLoc = null;
function setStats() {
  if (!ride) return;
  const el = (Date.now() - ride.start) / 1000;
  $('sDist').textContent = C.fmtKm(ride.dist);
  $('sTime').textContent = C.fmtDuration(el);
  $('sSpeed').textContent = Math.round(ride.speed || 0);
  $('sMax').textContent = Math.round(ride.maxSpeed);
  setArc('spdArc', (ride.speed || 0) / 120 * 100);
}
function onFix(p) {
  const c = p.coords;
  const fix = { lat: c.latitude, lon: c.longitude, acc: c.accuracy, t: p.timestamp };
  lastLoc = fix;
  $('gpsMsg').textContent = `GPS ±${Math.round(c.accuracy)} m`;
  if (!ride) return;
  const prev = ride.points[ride.points.length - 1];
  if (!C.acceptFix(prev, fix)) return;
  let sp = c.speed != null && !isNaN(c.speed) ? C.kmh(c.speed) : (prev ? C.kmh(C.haversine(prev, fix) / Math.max(1, (fix.t - prev.t) / 1000)) : 0);
  if (prev) ride.dist += C.haversine(prev, fix);
  ride.speed = sp; ride.maxSpeed = Math.max(ride.maxSpeed, sp);
  ride.points.push({ lat: fix.lat, lon: fix.lon, t: fix.t });
  line.addLatLng([fix.lat, fix.lon]);
  if (!marker) marker = L.circleMarker([fix.lat, fix.lon], { radius: 8, color: '#fff', fillColor: '#ff9d2e', fillOpacity: 1 }).addTo(map);
  else marker.setLatLng([fix.lat, fix.lon]);
  map.setView([fix.lat, fix.lon], Math.max(map.getZoom(), 16));
  setStats();
}
function onGpsErr(e) { $('gpsMsg').textContent = 'GPS error: ' + e.message + (location.protocol === 'http:' && location.hostname !== 'localhost' ? ' (geolocation needs HTTPS)' : ''); }
$('btnStart').onclick = async () => {
  if (!navigator.geolocation) return $('gpsMsg').textContent = 'Geolocation not supported';
  ride = { start: Date.now(), dist: 0, speed: 0, maxSpeed: 0, points: [], notes: '', photos: [] };
  line.setLatLngs([]); if (marker) { marker.remove(); marker = null; }
  watchId = navigator.geolocation.watchPosition(onFix, onGpsErr, { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 });
  timer = setInterval(setStats, 1000);
  try { wake = await navigator.wakeLock?.request('screen'); } catch {}
  $('btnStart').hidden = true; $('btnStop').hidden = false; $('gpsMsg').textContent = 'Waiting for GPS fix…';
};
$('btnStop').onclick = async () => {
  navigator.geolocation.clearWatch(watchId); clearInterval(timer); try { wake?.release(); } catch {}
  ride.end = Date.now(); ride.dur = (ride.end - ride.start) / 1000;
  ride.avgSpeed = ride.dur ? C.kmh(ride.dist / ride.dur) : 0;
  const r = ride; ride = null;
  $('btnStart').hidden = false; $('btnStop').hidden = true;
  if (r.points.length < 2 && r.dist < 50 && !confirm('Very short ride with almost no GPS data. Save anyway?')) return;
  delete r.speed; r.vehicleId = (await activeVehicle()).active.id; r.id = await put('rides', r);
  $('gpsMsg').textContent = `Saved: ${C.fmtKm(r.dist)} km in ${C.fmtDuration(r.dur)}`;
  ['sDist','sSpeed','sMax'].forEach(i => $(i).textContent = '0'); $('sTime').textContent = '00:00'; setArc('spdArc', 0); renderHome();
};

// ---------- ride log ----------
async function renderRides() {
  const rides = (await getAll('rides')).sort((a, b) => b.start - a.start);
  $('rideList').innerHTML = rides.length ? rides.map(r => `<div class="glass card item" data-id="${r.id}">
    <div><b>${new Date(r.start).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}</b><br>
    <small>${C.fmtKm(r.dist)} km · ${C.fmtDuration(r.dur)} · avg ${Math.round(r.avgSpeed)} / max ${Math.round(r.maxSpeed)} km/h${r.photos?.length ? ' · ' + ico('camera') + r.photos.length : ''}</small></div>${ico('chev')}</div>`).join('')
    : '<div class="glass card hint">No rides yet. Tap Start ride on Home to record your first one.</div>';
  $('rideList').querySelectorAll('[data-id]').forEach(e => e.onclick = () => openRide(+e.dataset.id));
}
let urls = [];
async function openRide(id) {
  const r = (await getAll('rides')).find(x => x.id === id); if (!r) return;
  urls.forEach(URL.revokeObjectURL); urls = [];
  const d = $('detail'); d.hidden = false;
  d.innerHTML = `<button id="dClose" class="ghost">${ico('back')}Back</button><h2>${new Date(r.start).toLocaleDateString('en-IN', { dateStyle: 'full' })}</h2>
  <div id="dmap" style="height:220px;border-radius:14px"></div>
  <p>${C.fmtKm(r.dist)} km · ${C.fmtDuration(r.dur)} · avg ${Math.round(r.avgSpeed)} km/h · max ${Math.round(r.maxSpeed)} km/h</p>
  <textarea id="dNotes" rows="4" placeholder="Notes about this ride…">${esc(r.notes)}</textarea>
  <label>Add photos <input id="dPhoto" type="file" accept="image/*" multiple></label>
  <div id="dPhotos"></div>
  <div class="row"><button id="dSave" class="primary">Save notes</button><button id="dDel" class="danger">Delete ride</button></div>
  <button id="dGpx" class="ghost" style="margin-top:8px">Export GPX</button>`;
  const dm = L.map('dmap'); L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(dm);
  if (r.points.length > 1) { const pl = L.polyline(r.points.map(p => [p.lat, p.lon]), { color: '#22e6ff', weight: 5, className: 'glow' }).addTo(dm); dm.fitBounds(pl.getBounds()); } else dm.setView([20.59, 78.96], 4);
  const drawPh = () => { urls.forEach(URL.revokeObjectURL); urls = [];
    $('dPhotos').innerHTML = ''; (r.photos || []).forEach((b, i) => { const u = URL.createObjectURL(b); urls.push(u); const im = new Image(); im.src = u; $('dPhotos').append(im); }); };
  drawPh();
  $('dPhoto').onchange = async e => { r.photos = (r.photos || []).concat([...e.target.files]); await put('rides', r); drawPh(); };
  $('dSave').onclick = async () => { r.notes = $('dNotes').value; await put('rides', r); $('dSave').textContent = 'Saved ✓'; };
  $('dDel').onclick = async () => { if (confirm('Delete this ride?')) { await del('rides', r.id); close(); renderRides(); } };
  $('dGpx').onclick = () => downloadGPX(r);
  const close = () => { dm.remove(); d.hidden = true; renderRides(); };
  $('dClose').onclick = close;
}

// ---------- vehicles, maintenance, tyres ----------
const todayIso = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
async function getVehicles() { // when nothing is saved there is one virtual default vehicle (carries the legacy odometer)
  const v = await kvGet('vehicles'); if (Array.isArray(v) && v.length) return v;
  return [{ id: 'v0', type: 'bike', make: '', model: '', year: null, fuel: 'petrol', odo: Number(await kvGet('odoBase')) || 0, auto: true }];
}
async function activeVehicle() { const vs = await getVehicles(); const id = await kvGet('activeVehicle'); return { vs, active: vs.find(v => v.id === id) || vs[0] }; }
async function vehicleState() {
  const { vs, active } = await activeVehicle(); const rides = await getAll('rides'); const defId = vs[0].id;
  const odo = C.vehicleOdo(active, rides, defId);
  const items = (await getAll('maint')).filter(i => (i.vehicleId || defId) === active.id);
  const ty = ((await kvGet('tyres')) || {})[active.id] || {};
  return { vs, active, rides, defId, odo, items, tyres: ty };
}
async function odometer() { return (await vehicleState()).odo; }
let editingVeh = null; // null = editing the active vehicle; 'new' = creating
function fillFuel(type, sel) { $('vFuel').innerHTML = C.FUELS[type].map(f => `<option value="${f}">${f === 'cng' ? 'CNG' : f[0].toUpperCase() + f.slice(1)}</option>`).join(''); if (sel && C.FUELS[type].includes(sel)) $('vFuel').value = sel; }
$('vType').onchange = () => fillFuel($('vType').value);
function showVErr(list) { $('vErr').hidden = !list || !list.length; $('vErr').textContent = (list || []).join('. '); }
async function renderMaint() {
  const S = await vehicleState(); const { active, odo, items } = S; const now = Date.now();
  $('vSel').innerHTML = S.vs.map(v => `<option value="${esc(v.id)}">${esc(v.auto ? 'My vehicle (set up profile)' : C.vehicleName(v))}</option>`).join('');
  $('vSel').value = active.id; $('odo').textContent = Math.round(odo).toLocaleString('en-IN');
  const nw = editingVeh === 'new';
  {
    const v = nw ? { type: 'bike', fuel: 'petrol' } : active; $('vType').value = v.type; fillFuel(v.type, v.fuel);
    $('vMake').value = v.make || ''; $('vModel').value = v.model || ''; $('vYear').value = v.year || ''; $('vOdo').value = nw ? '' : Math.round(odo);
  }
  $('vehDetails').open = nw || !!active.auto || $('vehDetails').open && editingVeh !== null; $('vfTitle').textContent = nw ? 'New vehicle' : 'Vehicle profile'; $('vDel').hidden = nw || S.vs.length < 1 || !!active.auto;
  $('tyreVeh').textContent = nw ? '' : '· ' + (active.auto ? 'My vehicle' : C.vehicleName(active));
  $('maintList').innerHTML = items.length ? items.map(it => { const s = C.maintStatus(it, odo, now); const nd = C.nextDue(it, odo, now);
    const cls = s.due ? 'due' : s.soon ? 'soon' : 'okc'; const mo = it.monthInterval || C.daysToMonths(it.dayInterval);
    const every = [it.kmInterval ? 'every ' + it.kmInterval.toLocaleString('en-IN') + ' km' : '', mo ? (it.kmInterval ? 'or ' : 'every ') + mo + ' mo' : ''].filter(Boolean).join(' ');
    return `<div class="glass card" data-mid="${it.id}"><div class="item"><div><b>${esc(it.name)}</b> ${it.suggested ? '<span class="sugtag" title="Generic guideline - verify with your manual">GUIDELINE</span>' : ''} <span class="${cls}">${s.due ? 'DUE' : s.soon ? 'SOON' : 'OK'}</span><br>
    <small>${esc(nd ? nd.text : 'no interval set')}${nd && nd.leftKm !== null && nd.leftDays !== null ? ' · ' + esc(nd.both) : ''} · ${esc(every)}${it.lastKm != null ? ' · last at ' + Math.round(it.lastKm) + ' km' : ''}${it.lastDate ? ' on ' + esc(it.lastDate) : ''}${it.cost ? ' · ' + C.fmtINR(it.cost) : ''}</small></div>
    <div class="acts"><button class="ghost small" data-act="done">Mark done</button><button class="ghost small" data-act="edit">Edit</button><button class="ghost small" data-act="rm" aria-label="Remove ${esc(it.name)}">${ico('close')}</button></div></div>
    <div class="maint-edit" data-panel="done" hidden><div class="row"><label>Done on<input type="date" class="fDate" value="${todayIso()}"></label><label>At odometer (km)<input type="number" inputmode="numeric" class="fOdo" value="${Math.round(odo)}"></label></div>
      <label>Cost ₹ (optional)<input type="number" inputmode="numeric" class="fCost" value="${it.cost || ''}"></label><div class="form-err" hidden></div><button class="primary small" data-save="done">Save as done</button></div>
    <div class="maint-edit" data-panel="edit" hidden><label>Name<input class="eName" value="${esc(it.name)}" maxlength="60"></label>
      <div class="row"><label>Every … km<input type="number" inputmode="numeric" min="0" class="eKm" value="${it.kmInterval || ''}"></label><label>Every … months<input type="number" inputmode="numeric" min="0" class="eMo" value="${mo || ''}"></label></div>
      <div class="row"><label>Last done at km<input type="number" inputmode="numeric" min="0" class="eLastKm" value="${it.lastKm != null ? Math.round(it.lastKm) : ''}"></label><label>Last done on<input type="date" class="eLastDate" value="${esc(it.lastDate || '')}"></label></div>
      <div class="form-err" hidden></div><button class="primary small" data-save="edit">Save changes</button></div></div>`; }).join('')
    : '<div class="glass card hint">No reminders for this vehicle yet. Tap “Suggest default schedule” or add one below.</div>';
  const rerr = (card, m) => { const e = card.querySelector('.maint-edit:not([hidden]) .form-err'); e.hidden = !m; e.textContent = m || ''; };
  $('maintList').querySelectorAll('[data-mid]').forEach(card => { const it = items.find(x => x.id == card.dataset.mid);
    card.querySelectorAll('[data-act]').forEach(b => b.onclick = async () => { const a = b.dataset.act;
      if (a === 'rm') { if (confirm('Remove “' + it.name + '”?')) { await del('maint', it.id); renderMaint(); } return; }
      card.querySelectorAll('.maint-edit').forEach(p => p.hidden = p.dataset.panel !== a || !p.hidden); });
    card.querySelector('[data-save=done]').onclick = async () => { try { const n = C.markDone(it, Number(card.querySelector('.fOdo').value), card.querySelector('.fDate').value, card.querySelector('.fCost').value); await put('maint', n); renderMaint(); } catch (e) { rerr(card, e.message); } };
    card.querySelector('[data-save=edit]').onclick = async () => {
      const name = card.querySelector('.eName').value.trim(), km = Number(card.querySelector('.eKm').value) || 0, mo = Number(card.querySelector('.eMo').value) || 0;
      const lk = card.querySelector('.eLastKm').value, ld = card.querySelector('.eLastDate').value;
      if (!name) return rerr(card, 'Name is required'); if (km < 0 || mo < 0) return rerr(card, 'Intervals cannot be negative'); if (!km && !mo) return rerr(card, 'Set an interval in km and/or months');
      if (ld && C.dayNum(ld) === null) return rerr(card, 'Invalid date'); if (lk !== '' && !(Number(lk) >= 0)) return rerr(card, 'Invalid odometer');
      await put('maint', Object.assign({}, it, { name, kmInterval: km || null, monthInterval: mo || null, dayInterval: C.monthsToDays(mo), lastKm: lk !== '' ? Number(lk) : it.lastKm, lastDate: ld || it.lastDate, suggested: it.suggested && name === it.name && km === it.kmInterval ? it.suggested : false })); renderMaint(); };
  });
  // tyres
  const T = S.tyres; const list = ['front', 'rear'].filter(p => T[p]);
  $('tyreList').innerHTML = list.map(p => { const st = C.tyreStatus(T[p], odo, now); if (!st) return '';
    return `<div class="glass card" data-tyre="${p}"><div class="item"><div><b>${p === 'front' ? 'Front' : 'Rear'} tyre</b> ${esc(T[p].brand || '')}<br><small>${Math.round(st.kmSince).toLocaleString('en-IN')} km since fitted${st.daysSince != null ? ' · ' + st.daysSince + ' days' : ''} · inspect in ${Math.round(st.kmToCheck)} km · ${st.pressureAgo == null ? 'pressure never logged' : 'pressure checked ' + st.pressureAgo + ' d ago'}${st.pressureDue ? ' <span class="soon">CHECK PRESSURE</span>' : ''}</small></div>
    <div class="acts"><button class="ghost small" data-t="press">Pressure checked today</button><button class="ghost small" data-t="rm" aria-label="Remove ${p} tyre">${ico('close')}</button></div></div></div>`; }).join('');
  $('tyreList').querySelectorAll('[data-tyre]').forEach(c => { const p = c.dataset.tyre;
    c.querySelector('[data-t=press]').onclick = async () => { const all = (await kvGet('tyres')) || {}; all[active.id][p].lastPressure = todayIso(); await kvSet('tyres', all); renderMaint(); };
    c.querySelector('[data-t=rm]').onclick = async () => { if (!confirm('Remove this tyre record?')) return; const all = (await kvGet('tyres')) || {}; delete all[active.id][p]; await kvSet('tyres', all); renderMaint(); }; });
  if (!$('tKm').value) $('tKm').value = Math.round(odo); if (!$('tDate').value) $('tDate').value = todayIso();
}
$('vSel').onchange = async () => { editingVeh = null; await kvSet('activeVehicle', $('vSel').value); renderMaint(); renderHome(); };
$('vNew').onclick = () => { editingVeh = 'new'; showVErr([]); renderMaint().then(() => $('vMake').focus()); };
$('vehForm').onsubmit = async e => { e.preventDefault();
  const S = await vehicleState(); const nw = editingVeh === 'new';
  const r = C.normalizeVehicle({ type: $('vType').value, fuel: $('vFuel').value, make: $('vMake').value, model: $('vModel').value, year: $('vYear').value, odo: $('vOdo').value });
  if (!r.ok) return showVErr(r.errors); showVErr([]);
  const v = r.value; const id = nw ? 'v' + Date.now() : S.active.id; v.id = id;
  const tracked = nw ? 0 : C.vehicleOdo({ id, odo: 0 }, S.rides, S.defId); v.odo = Math.max(0, v.odo - tracked); // entered = current reading; store base so tracked rides keep adding
  const vs = S.vs.filter(x => !x.auto); if (nw) vs.push(v); else { const i = vs.findIndex(x => x.id === id); if (i >= 0) vs[i] = v; else vs.unshift(v); }
  await kvSet('vehicles', vs); await kvSet('activeVehicle', id); editingVeh = null; renderMaint(); renderHome(); };
$('vDel').onclick = async () => { const S = await vehicleState(); if (S.active.auto || !confirm('Delete ' + C.vehicleName(S.active) + ' and its service reminders and tyre records? Rides are kept.')) return;
  for (const it of S.items) await del('maint', it.id);
  const all = (await kvGet('tyres')) || {}; delete all[S.active.id]; await kvSet('tyres', all);
  const vs = S.vs.filter(x => x.id !== S.active.id); await kvSet('vehicles', vs); await kvSet('activeVehicle', vs[0] ? vs[0].id : null); editingVeh = null; renderMaint(); renderHome(); };
$('vSuggest').onclick = async () => { const S = await vehicleState();
  if (S.active.auto) { showVErr(['Save the vehicle profile first (type, make, fuel) so the suggested schedule matches it']); $('vMake').focus(); return; }
  const add = C.scheduleItems(S.active, S.odo, todayIso(), S.items);
  if (!add.length) { showVErr(['All suggested items already exist for this vehicle']); return; }
  for (const it of add) await put('maint', it); showVErr([]); renderMaint(); renderHome(); };
$('maintForm').onsubmit = async e => { e.preventDefault();
  const S = await vehicleState(); const km = Number($('mKm').value) || 0, mo = Number($('mMonths').value) || 0;
  if (!km && !mo) return alert('Set an interval in km and/or months');
  await put('maint', { name: $('mCustom').value.trim() || $('mName').value, kmInterval: km || null, monthInterval: mo || null, dayInterval: C.monthsToDays(mo), vehicleId: S.active.id,
    lastKm: $('mLastKm').value !== '' ? Number($('mLastKm').value) : Math.round(S.odo), lastDate: $('mLastDate').value || todayIso(), cost: Number($('mCost').value) || null });
  e.target.reset(); renderMaint(); renderHome(); };
$('tyreForm').onsubmit = async e => { e.preventDefault();
  const S = await vehicleState(); const km = Number($('tKm').value); if (!(km >= 0) || $('tKm').value === '') return alert('Enter the odometer reading when the tyre was fitted');
  const all = (await kvGet('tyres')) || {}; all[S.active.id] = all[S.active.id] || {};
  all[S.active.id][$('tPos').value] = { brand: $('tBrand').value.trim().slice(0, 40), installKm: km, installDate: $('tDate').value || '', lastPressure: $('tPress').value || '' };
  await kvSet('tyres', all); $('tBrand').value = ''; $('tPress').value = ''; renderMaint(); renderHome(); };

// ---------- settings ----------
async function loadSettings() {
  const s = (await kvGet('settings')) || {};
  $('setName').value = s.name || ''; $('setPhone').value = s.phone || ''; $('setPhone2').value = s.contactName || '';
  $('setVia').value = s.via || 'sms'; $('setImpact').value = s.impact || 30; return s;
}
$('setForm').onsubmit = async e => { e.preventDefault();
  await kvSet('settings', { name: $('setName').value, phone: $('setPhone').value, contactName: $('setPhone2').value, via: $('setVia').value, impact: Number($('setImpact').value) || 30 });
  $('setMsg').textContent = 'Saved.'; if (detector) detector.o.impact = Number($('setImpact').value) || 30; };

// ---------- crash detection ----------
let detector = null, motionHandler = null, sosTimer = null;
async function startCrash() {
  if (typeof DeviceMotionEvent === 'undefined') { $('crashMsg').textContent = 'Motion sensors not available on this device/browser.'; $('crashOn').checked = false; return; }
  if (typeof DeviceMotionEvent.requestPermission === 'function') {
    try { if (await DeviceMotionEvent.requestPermission() !== 'granted') throw 0; } catch { $('crashMsg').textContent = 'Motion permission denied.'; $('crashOn').checked = false; return; }
  }
  const s = (await kvGet('settings')) || {};
  if (!s.phone) $('crashMsg').textContent = 'Warning: no emergency contact saved (SOS tab).';
  detector = new C.CrashDetector({ impact: s.impact || 30 });
  let got = false;
  motionHandler = e => { const a = e.accelerationIncludingGravity; if (!a || a.x == null) return; got = true;
    if (detector.feed({ t: Date.now(), mag: Math.hypot(a.x, a.y, a.z) })) triggerSOS(); };
  addEventListener('devicemotion', motionHandler);
  $('crashMsg').textContent = 'Crash alert armed. Keep the phone secured on the bike.';
  setTimeout(() => { if (!got && $('crashOn').checked) $('crashMsg').textContent = 'No motion data received — this device may not support it (desktops usually do not).'; }, 3000);
}
function stopCrash() { removeEventListener('devicemotion', motionHandler); detector = null; $('crashMsg').textContent = ''; }
$('crashOn').onchange = e => e.target.checked ? startCrash() : stopCrash();
$('btnTestCrash').onclick = () => triggerSOS();

async function triggerSOS() {
  if (!$('sos').hidden) return;
  const s = (await kvGet('settings')) || {};
  let n = 20; $('sos').hidden = false; $('sosSend').hidden = true; $('sosCancel').hidden = false;
  const upd = () => { $('sosCount').textContent = n; $('sosSec').textContent = n; };
  upd(); navigator.vibrate?.([500, 200, 500]);
  const beep = () => { try { const ac = beep.ac ||= new AudioContext(); const o = ac.createOscillator(); o.connect(ac.destination); o.frequency.value = 880; o.start(); o.stop(ac.currentTime + .2); } catch {} };
  sosTimer = setInterval(() => { n--; upd(); beep(); navigator.vibrate?.(200);
    if (n <= 0) { clearInterval(sosTimer); fire(s); } }, 1000);
}
function fire(s) {
  const links = C.alertLinks(s.phone, s.name, lastLoc);
  const href = s.via === 'whatsapp' ? links.whatsapp : links.sms;
  $('sosCount').textContent = '!'; $('sosCancel').hidden = true; $('sosSend').hidden = false;
  if (!s.phone) { $('sosSend').innerHTML = '<p>No emergency contact saved! Call 112.</p><a class="btn danger big" href="tel:112">Call 112</a>'; return; }
  $('sosLink').href = href;
  location.href = href; // may be blocked without a user tap; the button above is the fallback
}
$('sosCancel').onclick = () => { clearInterval(sosTimer); $('sos').hidden = true; detector?.reset(); };

// ---------- group ride (real: server/ + SSE + POST) ----------
const G = { sess: null, snap: null, offset: 0, map: null, markers: {}, destMk: null, es: null, poll: null, send: null, watch: null, fix: null, fitted: false,
  pick: false, route: null, routedFor: null, routeLine: null, lastRouteAt: 0, lastSearchAt: 0, cache: new Map(), lastEvt: 0 };
window.__grp = G;
const GKEY = 'rk-group';
const gShow = (el, on) => { $(el).hidden = !on; };
function gMsg(t) { $('gMsg').hidden = !t; $('gMsg').textContent = t || ''; }
async function gApi(method, path, body) {
  const r = await fetch('/api/groups' + path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  let j = {}; try { j = await r.json(); } catch {}
  if (!r.ok) { const e = new Error(j.error || ('HTTP ' + r.status)); e.status = r.status; throw e; } return j;
}
async function gName() { const n = $('gName').value.trim(); if (n) { const st = (await kvGet('settings')) || {}; if (!st.name) { st.name = n; await kvSet('settings', st); } } return n; }
function gSave(sess) { G.sess = sess; if (sess) localStorage.setItem(GKEY, JSON.stringify(sess)); else localStorage.removeItem(GKEY); }
function gNow() { return Date.now() + G.offset; }
function gInitMap() {
  if (G.map) return; G.map = L.map('gmap', { zoomControl: true }).setView([20.5937, 78.9629], 5);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap contributors' }).addTo(G.map);
  G.map.on('click', e => { if (!G.pick) return; G.pick = false; $('gPick').classList.remove('primary'); setDest(e.latlng.lat, e.latlng.lng, 'Dropped pin ' + e.latlng.lat.toFixed(4) + ', ' + e.latlng.lng.toFixed(4)); });
}
function gStart(sess) {
  gSave(sess); gMsg(''); gShow('gSetup', false); gShow('gBox', true); $('gCodeShow').textContent = sess.code;
  gInitMap(); setTimeout(() => G.map.invalidateSize(), 50); G.fitted = false;
  gConnect(); clearInterval(G.poll); G.poll = setInterval(gPoll, 5000); clearInterval(G.send); G.send = setInterval(gSendLoc, 5000);
  if (navigator.geolocation && G.watch == null) G.watch = navigator.geolocation.watchPosition(p => { G.fix = { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy, speed: p.coords.speed, t: Date.now() };
    if (G.firstFix !== true) { G.firstFix = true; gSendLoc(); } maybeRoute(); }, e => gMsg('Location unavailable: ' + e.message + '. You can still see others.'), { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 });
  try { navigator.wakeLock?.request('screen').then(w => G.wake = w).catch(() => {}); } catch {}
}
function gStop(msg) {
  gSave(null); G.es?.close(); G.es = null; clearInterval(G.poll); clearInterval(G.send);
  if (G.watch != null) navigator.geolocation.clearWatch(G.watch); G.watch = null; G.firstFix = false; try { G.wake?.release(); } catch {}
  Object.values(G.markers).forEach(m => m.remove()); G.markers = {}; G.destMk?.remove(); G.destMk = null; G.routeLine?.remove(); G.routeLine = null; G.route = null; G.routedFor = null; G.snap = null;
  gShow('gBox', false); gShow('gSetup', true); gShow('gDest', false); gMsg(msg || '');
}
function gConnect() {
  G.es?.close(); const s = G.sess; if (!s || !window.EventSource) return;
  G.es = new EventSource('/api/groups/' + encodeURIComponent(s.code) + '/events?token=' + s.token);
  G.es.addEventListener('state', e => { G.lastEvt = Date.now(); gApply(JSON.parse(e.data)); $('gConn').textContent = 'Live'; });
  G.es.onerror = () => { $('gConn').textContent = 'Reconnecting…'; };
}
async function gPoll() { // fallback when SSE is silent (proxies that buffer / mobile networks); server only pushes on change
  const s = G.sess; if (!s) return; if (Date.now() - G.lastEvt < 12000 && G.es && G.es.readyState === 1) return;
  try { gApply(await gApi('GET', '/' + encodeURIComponent(s.code) + '?token=' + s.token)); $('gConn').textContent = 'Live (polling)'; }
  catch (e) { if (e.status === 403 || e.status === 404) gStop('That group has ended or you were removed.'); else $('gConn').textContent = 'Offline – retrying'; }
}
let lastSent = 0;
async function gSendLoc() {
  const s = G.sess, f = G.fix; if (!s || !f || Date.now() - lastSent < 900) return; lastSent = Date.now();
  try { await gApi('POST', '/' + encodeURIComponent(s.code) + '/location', { token: s.token, lat: f.lat, lng: f.lng, acc: f.acc, speed: f.speed != null && f.speed >= 0 ? f.speed : undefined }); }
  catch (e) { if (e.status === 403 || e.status === 404) gStop('That group has ended or you were removed.'); }
}
function gApply(snap) {
  G.snap = snap; G.offset = snap.now - Date.now(); renderGroup(); maybeRoute();
}
function labelIcon(m, me, off) { return L.divIcon({ className: '', iconSize: [16, 16], iconAnchor: [8, 8],
  html: `<div class="gdot${me ? ' me' : ''}${off ? ' off' : ''}" style="background:${esc(m.color)}"><span class="glabel">${esc(m.name)}</span></div>` }); }
function renderGroup() {
  const snap = G.snap, s = G.sess; if (!snap || !s) return;
  const dest = snap.dest; const rows = C.groupFlags(snap.members, dest, gNow());
  const ids = new Set(rows.map(r => r.id));
  Object.keys(G.markers).forEach(id => { if (!ids.has(id)) { G.markers[id].remove(); delete G.markers[id]; } });
  rows.forEach(r => { if (!r.hasPos) return; const me = r.id === s.memberId; const ic = labelIcon(r, me, !r.online);
    if (G.markers[r.id]) { G.markers[r.id].setLatLng([r.lat, r.lng]).setIcon(ic); } else G.markers[r.id] = L.marker([r.lat, r.lng], { icon: ic, title: r.name, zIndexOffset: me ? 500 : 0 }).addTo(G.map); });
  if (dest) { const ic = L.divIcon({ className: '', iconSize: [26, 26], html: '<div class="gflag"><svg viewBox="0 0 24 24"><use href="#i-flag"/></svg></div>' });
    if (G.destMk) G.destMk.setLatLng([dest.lat, dest.lng]); else G.destMk = L.marker([dest.lat, dest.lng], { icon: ic, title: dest.name, zIndexOffset: 1000 }).addTo(G.map); }
  else { G.destMk?.remove(); G.destMk = null; }
  if (!G.fitted && (rows.some(r => r.hasPos) || dest)) { G.fitted = true; gFit(); }
  // dest card
  gShow('gDest', !!dest);
  if (dest) { $('gDestName').textContent = dest.name; $('gDestBy').textContent = 'set by ' + dest.by; $('gGmaps').href = C.gmapsLink(dest, G.fix ? { lat: G.fix.lat, lon: G.fix.lng } : null); }
  // alerts
  const al = []; rows.forEach(r => { if (r.stopped) al.push(`<b>${esc(r.name)}</b> has not moved for ${Math.floor((gNow() - r.movedAt) / 60000)} min`); if (r.behind) al.push(`<b>${esc(r.name)}</b> is far behind (${C.fmtDist(r.behindBy)} ${dest ? 'behind the leader' : 'from the group'})`); });
  $('gAlert').hidden = !al.length; $('gAlert').innerHTML = al.length ? ico('warn') + 'Regroup: ' + al.join(' · ') : '';
  // riders list
  const sorted = rows.slice().sort((a, b) => (a.distToDest ?? 1e12) - (b.distToDest ?? 1e12));
  $('gRiders').innerHTML = sorted.map(r => `<div class="glass card item" data-mid="${esc(r.id)}"><div><span class="cdot" style="background:${esc(r.color)}"></span><b>${esc(r.name)}</b>${r.id === s.memberId ? ' (you)' : ''}
    ${r.stopped ? '<span class="tag stop">STOPPED</span>' : ''}${r.behind ? '<span class="tag far">FAR BEHIND</span>' : ''}${!r.online ? '<span class="tag off">OFFLINE?</span>' : ''}<br>
    <small>${r.hasPos ? '' : 'no GPS fix yet · '}${dest && r.hasPos ? C.fmtDist(r.distToDest) + ' to destination (straight line) · ' : ''}seen ${esc(C.fmtAgo(gNow() - r.lastSeen))}${r.speed != null ? ' · ' + Math.round(r.speed * 3.6) + ' km/h' : ''}</small></div></div>`).join('');
  $('gRiders').querySelectorAll('[data-mid]').forEach(el => el.onclick = () => { const m = G.markers[el.dataset.mid]; if (m) { G.map.setView(m.getLatLng(), Math.max(G.map.getZoom(), 15)); window.scrollTo({ top: $('gmap').offsetTop - 60, behavior: 'smooth' }); } });
}
function gFit() {
  const pts = Object.values(G.markers).map(m => m.getLatLng()); if (G.snap?.dest) pts.push(L.latLng(G.snap.dest.lat, G.snap.dest.lng));
  if (pts.length === 1) G.map.setView(pts[0], 15); else if (pts.length) G.map.fitBounds(L.latLngBounds(pts).pad(0.25));
}
async function setDest(lat, lng, name) {
  const s = G.sess; if (!s) return;
  try { await gApi('POST', '/' + encodeURIComponent(s.code) + '/destination', { token: s.token, lat, lng, name }); gMsg(''); }
  catch (e) { gMsg('Could not set destination: ' + e.message); }
}
// --- routing (OSRM public demo; car profile; fair-use: only on destination change / button, >=5 s apart) ---
async function maybeRoute(force) {
  const d = G.snap?.dest; if (!d) { G.route = null; G.routedFor = null; G.routeLine?.remove(); G.routeLine = null; $('gSteps').innerHTML = ''; $('gRouteInfo').textContent = ''; return; }
  const key = d.lat + ',' + d.lng + '@' + d.at; if (!force && G.routedFor === key) return;
  if (!G.fix) { $('gRouteInfo').textContent = 'Waiting for your GPS fix to plan a route…'; return; }
  if (Date.now() - G.lastRouteAt < 5000) { if (!force) setTimeout(maybeRoute, 5200 - (Date.now() - G.lastRouteAt)); return; }
  G.lastRouteAt = Date.now(); G.routedFor = key; $('gRouteInfo').textContent = 'Finding route…';
  try {
    const u = `https://router.project-osrm.org/route/v1/driving/${G.fix.lng.toFixed(6)},${G.fix.lat.toFixed(6)};${d.lng.toFixed(6)},${d.lat.toFixed(6)}?overview=full&geometries=geojson&steps=true`;
    const r = await fetch(u); const j = await r.json().catch(() => null); if (!r.ok && !j) throw new Error('routing service HTTP ' + r.status);
    const rt = C.parseRoute(j); G.route = rt; G.routeLine?.remove(); G.routeLine = L.polyline(rt.line, { color: '#d946ef', weight: 5, opacity: .9, className: 'glow-am' }).addTo(G.map);
    G.map.fitBounds(G.routeLine.getBounds().pad(0.15));
    $('gRouteInfo').innerHTML = `<b>${C.fmtDist(rt.distance)}</b> · about ${Math.max(1, Math.round(rt.duration / 60))} min by car <small>(estimate, not live traffic)</small>`;
    $('gSteps').innerHTML = rt.steps.map(st => `<li>${esc(st.text)} <small>${st.dist ? '· ' + esc(C.fmtDist(st.dist)) : ''}</small></li>`).join('');
  } catch (e) { G.routedFor = null; $('gRouteInfo').innerHTML = 'Could not get a route (' + esc(e.message) + '). Use “Open in Google Maps” instead.'; $('gSteps').innerHTML = ''; }
}
// --- place search (Nominatim: user-initiated only, max 1 req/s, cached, no autocomplete) ---
$('gSearchForm').onsubmit = async e => { e.preventDefault(); const q = $('gQ').value.trim(); if (q.length < 3) return;
  const box = $('gResults'); const key = q.toLowerCase();
  const wait = 1100 - (Date.now() - G.lastSearchAt); if (wait > 0) await new Promise(r => setTimeout(r, wait));
  let list = G.cache.get(key); box.innerHTML = '<div class="glass card hint">Searching…</div>';
  try { if (!list) { G.lastSearchAt = Date.now(); const r = await fetch('https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&q=' + encodeURIComponent(q)); if (!r.ok) throw new Error('HTTP ' + r.status); list = await r.json(); G.cache.set(key, list); }
    box.innerHTML = list.length ? list.map((p, i) => `<div class="glass card" data-i="${i}">${esc(p.display_name)}</div>`).join('') + '<small class="hint">Search © OpenStreetMap contributors (Nominatim)</small>' : '<div class="glass card hint">No results.</div>';
    box.querySelectorAll('[data-i]').forEach(el => el.onclick = () => { const p = list[+el.dataset.i]; box.innerHTML = ''; setDest(+p.lat, +p.lon, p.display_name.split(',').slice(0, 2).join(',').trim()); });
  } catch (err) { box.innerHTML = '<div class="glass card warn">Search failed: ' + esc(err.message) + '. Tap the map instead.</div>'; } };
$('gPick').onclick = () => { G.pick = !G.pick; $('gPick').classList.toggle('primary', G.pick); gMsg(G.pick ? 'Tap the map to set the destination.' : ''); };
$('gFit').onclick = gFit;
$('gRoute').onclick = () => maybeRoute(true);
$('gDestClear').onclick = async () => { try { await gApi('POST', '/' + encodeURIComponent(G.sess.code) + '/destination', { token: G.sess.token, lat: null }); } catch (e) { gMsg(e.message); } };
async function gEnter(kind) {
  const name = await gName(); if (!name) { gMsg('Enter your rider name first.'); return; }
  try {
    let r;
    if (kind === 'create') r = await gApi('POST', '', { rider: name });
    else { const code = C.normCode($('gCode').value); if (!/^RIDE-\d{4}$/.test(code)) { gMsg('Code looks like RIDE-4821.'); return; } r = await gApi('POST', '/' + code + '/join', { rider: name }); }
    gStart({ code: r.code, token: r.token, memberId: r.memberId, name }); gApply(r.state);
  } catch (e) { gMsg(e.status === 404 ? 'No group with that code (it may have expired).' : e.message); }
}
$('gCreate').onclick = () => gEnter('create'); $('gJoin').onclick = () => gEnter('join');
$('gShare').onclick = async () => { const url = location.origin + location.pathname + '?join=' + G.sess.code; const text = 'Join my ride on RiderKit: code ' + G.sess.code;
  try { if (navigator.share) await navigator.share({ title: 'RiderKit group ride', text, url }); else { await navigator.clipboard.writeText(url); gMsg('Link copied: ' + url); } } catch { gMsg('Share link: ' + url); } };
$('gLeave').onclick = async () => { const s = G.sess; if (!s) return; try { await gApi('POST', '/' + encodeURIComponent(s.code) + '/leave', { token: s.token }); } catch {} gStop(''); };
(async () => { // join-link autofill + resume session
  const st = (await kvGet('settings')) || {}; if (st.name) $('gName').value = st.name;
  const code = C.codeFromSearch(location.search); if (code) { $('gCode').value = code; showTab('group'); gMsg('Enter your name and tap Join to enter ' + code + '.'); }
  let sess; try { sess = JSON.parse(localStorage.getItem(GKEY) || 'null'); } catch {}
  if (sess && sess.token && (!code || code === sess.code)) { try { const snap = await gApi('GET', '/' + encodeURIComponent(sess.code) + '?token=' + sess.token); gStart(sess); gApply(snap); } catch (e) { if (e.status === 403 || e.status === 404) gSave(null); } }
})();


// ---------- GPX export / import ----------
function downloadGPX(r) {
  const name = 'riderkit-' + new Date(r.start).toISOString().slice(0, 16).replace(/[:T]/g, '-') + '.gpx';
  const blob = new Blob([C.toGPX(r)], { type: 'application/gpx+xml' });
  const u = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = u; a.download = name; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(u), 5000);
}
function viewRoute(g) {
  const d = $('detail'); d.hidden = false;
  d.innerHTML = `<button id="dClose" class="ghost">${ico('back')}Back</button><h2>${esc(g.name)}</h2><span class="badge">IMPORTED</span>
  <div id="dmap" style="height:300px;border-radius:14px;margin-top:8px"></div>
  <p>${g.points.length} points · ${C.fmtKm(C.totalDistance(g.points))} km (straight-line between points)</p>
  <small class="hint">Viewing only - not saved to your ride log.</small>`;
  const dm = L.map('dmap'); L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(dm);
  const ll = g.points.map(p => [p.lat, p.lon]);
  if (ll.length > 1) { const pl = L.polyline(ll, { color: '#22e6ff', weight: 5, className: 'glow' }).addTo(dm); dm.fitBounds(pl.getBounds()); } else dm.setView(ll[0], 14);
  L.circleMarker(ll[0], { radius: 7, color: '#fff', fillColor: '#3ee8a0', fillOpacity: 1 }).addTo(dm);
  $('dClose').onclick = () => { dm.remove(); d.hidden = true; };
}
$('gpxFile').onchange = async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  try { viewRoute(C.parseGPX(await f.text())); $('gpxMsg').textContent = ''; }
  catch (err) { $('gpxMsg').textContent = 'Could not import: ' + err.message; }
};

// ---------- documents ----------
async function getDocs() {
  const saved = (await kvGet('docs')) || {};
  return Object.keys(C.DOC_TYPES).map(k => ({ type: k, name: C.DOC_TYPES[k], expiry: saved[k]?.expiry || '', number: saved[k]?.number || '' }));
}
async function renderDocs() {
  const docs = await getDocs();
  $('docList').innerHTML = docs.map(d => { const st = C.docStatus(d); const cls = st.state === 'expired' ? 'due' : st.state === 'soon' ? 'soon' : st.state === 'ok' ? 'okc' : '';
    return `<div class="glass card" data-doc="${d.type}"><div class="item"><b>${esc(d.name)}</b><span class="${cls}">${esc(st.label)}</span></div>
    <div class="row"><label>Expiry date<input type="date" class="dxExp" value="${esc(d.expiry)}"></label><label>Number (optional)<input class="dxNum" value="${esc(d.number)}"></label></div>
    <button class="primary small dxSave">Save</button></div>`; }).join('');
  $('docList').querySelectorAll('[data-doc]').forEach(c => c.querySelector('.dxSave').onclick = async () => {
    const saved = (await kvGet('docs')) || {}; const exp = c.querySelector('.dxExp').value;
    saved[c.dataset.doc] = { expiry: exp, number: c.querySelector('.dxNum').value.trim() }; await kvSet('docs', saved); await renderDocs(); refreshDocBanner(); renderHome(); });
}
async function refreshDocBanner() {
  const al = C.docAlerts((await getDocs()).filter(d => d.expiry));
  const b = $('docBanner'); if (!al.length) { b.hidden = true; return; }
  b.hidden = false; b.className = al.some(a => a.state === 'expired') ? 'bad' : '';
  b.innerHTML = al.map(a => `<div><b>${esc(a.doc.name)}</b>: <span class="${a.state === 'expired' ? 'due' : 'soon'}">${esc(a.label)}</span></div>`).join('') + '<a id="docGo">Update documents</a>';
  $('docGo').onclick = () => showTab('docs');
}

// ---------- roadside help ----------
let editId = null;
async function getContacts() { const c = await kvGet('contacts'); return Array.isArray(c) ? c : C.DEFAULT_CONTACTS(); }
async function renderContacts() {
  const cs = await getContacts();
  $('contactList').innerHTML = cs.length ? cs.map(c => { const tel = C.telLink(c.number);
    return `<div class="glass card" data-cid="${esc(c.id)}"><div class="item"><div><b>${esc(c.name)}</b> ${c.verify ? '<span class="badge">VERIFY</span>' : ''}<br><small>${esc(c.number || 'No number yet')}${c.note ? ' · ' + esc(c.note) : ''}</small></div>
    <div class="acts">${tel ? `<a class="btn call" href="${esc(tel)}">Call</a>` : ''}<button class="ghost small cEdit">Edit</button><button class="ghost small cDel" aria-label="Delete contact">${ico('close')}</button></div></div></div>`; }).join('')
    : '<div class="glass card hint">No contacts. Add one below.</div>';
  $('contactList').querySelectorAll('[data-cid]').forEach(el => {
    el.querySelector('.cEdit').onclick = () => { const c = cs.find(x => x.id === el.dataset.cid); editId = c.id; $('cName').value = c.name; $('cNum').value = c.number; $('cNote').value = c.note || '';
      $('cfTitle').textContent = 'Edit contact'; $('cCancel').hidden = false; $('cName').focus(); };
    el.querySelector('.cDel').onclick = async () => { if (!confirm('Delete this contact?')) return; await kvSet('contacts', cs.filter(x => x.id !== el.dataset.cid)); renderContacts(); };
  });
}
function resetContactForm() { editId = null; $('contactForm').reset(); $('cfTitle').textContent = 'Add contact'; $('cCancel').hidden = true; }
$('cCancel').onclick = resetContactForm;
$('contactForm').onsubmit = async e => { e.preventDefault();
  const cs = await getContacts(); const v = { name: $('cName').value.trim(), number: $('cNum').value.trim(), note: $('cNote').value.trim() };
  if (editId) { const i = cs.findIndex(x => x.id === editId); if (i >= 0) cs[i] = Object.assign({}, cs[i], v, { verify: false }); } // user-edited -> no longer a prefilled default
  else cs.push(Object.assign({ id: 'c' + Date.now(), verify: false }, v));
  await kvSet('contacts', cs); resetContactForm(); renderContacts(); };
$('contactReset').onclick = async () => { if (confirm('Replace all contacts with the defaults?')) { await kvSet('contacts', C.DEFAULT_CONTACTS()); renderContacts(); } };
function updShare() { const s = (window.__shareCtx ||= {}); const l = C.shareLocationLinks($('shareNum').value, s.name, lastLoc);
  $('shareWa').href = l.whatsapp; $('shareSms').href = l.sms; $('shareMsg').textContent = lastLoc ? `Last fix: ${lastLoc.lat.toFixed(5)}, ${lastLoc.lon.toFixed(5)} (${new Date(lastLoc.t).toLocaleTimeString('en-IN')}, ±${Math.round(lastLoc.acc || 0)} m)` : 'No location yet. Starting GPS - tap again in a few seconds. The message will say location is unavailable until then.'; }
$('shareLoc').onclick = async () => {
  window.__shareCtx = { name: ((await kvGet('settings')) || {}).name };
  if (!lastLoc && navigator.geolocation) navigator.geolocation.getCurrentPosition(onFix, onGpsErr, { enableHighAccuracy: true, timeout: 15000 });
  $('shareBox').hidden = false; updShare(); setTimeout(updShare, 3000); };
$('shareNum').oninput = updShare;

// ---------- HOME dashboard ----------
const fmtNum = (n, d) => Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: d == null ? 0 : d });
const fmtHM = sec => { sec = Math.round(sec || 0); const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60); return h ? h + 'h ' + String(m).padStart(2, '0') + 'm' : m + 'm'; };
const setArc = (id, pct) => { const p = Math.max(0, Math.min(100, pct)); $(id).setAttribute('stroke-dasharray', (p > 0 && p < 1.5 ? 1.5 : p) + ' 100'); };
async function loadData() {
  const demo = !!(await kvGet('demo'));
  if (demo) { const d = C.demoData(); return { demo, rides: d.rides, vehicle: d.vehicle, odo: d.odo, maint: d.maint, tyres: d.tyres, docs: d.docs }; }
  const S = await vehicleState(); const docs = {}; (await getDocs()).forEach(x => { docs[x.type] = { expiry: x.expiry }; });
  return { demo, rides: S.rides, vehicle: S.active, odo: S.odo, maint: S.items, tyres: S.tyres, docs };
}
function barsHTML(series, fmt, nowIdx) {
  const max = Math.max(...series.map(s => s.km), 0.0001);
  return series.map((s, i) => `<div class="bar${s.km === 0 ? ' zero' : ''}${i === nowIdx ? ' now' : ''}"><em>${s.km ? fmt(s.km) : ''}</em><span style="height:${s.km ? Math.max(6, s.km / max * 78) : 3}px"></span><b>${esc(s.label)}</b></div>`).join('');
}
let HM = null, hmLayer = null;
function drawHomeMap(rides) {
  if (!HM) { HM = L.map('homeMap', { zoomControl: false, attributionControl: true }).setView([20.5937, 78.9629], 4);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '© OpenStreetMap contributors' }).addTo(HM); hmLayer = L.layerGroup().addTo(HM); window.__homeMap = HM; }
  hmLayer.clearLayers(); const all = []; const sorted = rides.slice().sort((a, b) => a.start - b.start);
  sorted.forEach((r, i) => { const ll = C.thin(r.points || [], 250).map(p => [p.lat, p.lon]); if (ll.length < 2) return; all.push(...ll); const latest = i === sorted.length - 1;
    L.polyline(ll, { color: latest ? '#ff9d2e' : '#22e6ff', weight: 9, opacity: .16, interactive: false }).addTo(hmLayer);
    L.polyline(ll, { color: latest ? '#ff9d2e' : '#22e6ff', weight: 2.6, opacity: .95, className: latest ? 'glow-am' : 'glow', interactive: false }).addTo(hmLayer); });
  $('homeMapEmpty').hidden = all.length > 0;
  if (all.length) HM.fitBounds(L.latLngBounds(all).pad(0.15), { maxZoom: 13 }); else HM.setView([20.5937, 78.9629], 4);
}
function ringCard(pct, cls, inner) { return `<div class="rwrap"><svg viewBox="0 0 120 120" class="ring" aria-hidden="true"><circle class="ring-bg" cx="60" cy="60" r="52"/><circle class="ring-fg ${cls}" cx="60" cy="60" r="52" pathLength="100" stroke-dasharray="${Math.max(1.5, Math.min(100, pct))} 100"/></svg><i>${inner}</i></div>`; }
async function renderHome() {
  const D = await loadData(), now = Date.now(), st = C.rideStats(D.rides, now);
  $('demoBar').hidden = !D.demo; $('demoToggle').checked = D.demo;
  $('hKm').textContent = fmtNum(st.totalKm, st.totalKm < 100 ? 1 : 0); setArc('heroArc', st.count ? (st.totalKm % 1000) / 10 : 0);
  $('hMilestone').textContent = st.count ? fmtNum(1000 - st.totalKm % 1000) + ' km to your next 1,000 km milestone' : 'Ride to light up this ring.';
  $('homeStartTxt').textContent = ride ? 'Resume ride' : 'Start ride';
  $('homeEmpty').hidden = st.count > 0; $('hRides').textContent = st.count; $('hTime').textContent = fmtHM(st.totalSec);
  $('hTop').textContent = Math.round(st.topSpeed); $('hAvg').textContent = fmtNum(st.avgSpeed, 1);
  $('hWeekKm').textContent = fmtNum(st.week.km, 1); $('hMonthKm').textContent = fmtNum(st.month.km, 1);
  $('hWeekSub').textContent = st.week.rides + ' ride' + (st.week.rides === 1 ? '' : 's') + ' · ' + fmtHM(st.week.sec) + ' (since Monday)';
  $('hMonthSub').textContent = st.month.rides + ' ride' + (st.month.rides === 1 ? '' : 's') + ' · ' + fmtHM(st.month.sec);
  $('chart7').innerHTML = barsHTML(st.days, k => fmtNum(k, k < 10 ? 1 : 0), 6); $('chart6').innerHTML = barsHTML(st.months, k => fmtNum(k, 0), 5);
  $('chart7').setAttribute('aria-label', 'Kilometres per day, last 7 days: ' + st.days.map(d => d.label + ' ' + fmtNum(d.km, 1)).join(', '));
  $('chart6').setAttribute('aria-label', 'Kilometres per month, last 6 months: ' + st.months.map(d => d.label + ' ' + fmtNum(d.km, 0)).join(', '));
  // places
  const cells = C.gridCells(D.rides); $('placeCount').textContent = '≈ ' + cells.length + ' area' + (cells.length === 1 ? '' : 's');
  drawHomeMap(D.rides); setTimeout(() => HM && HM.invalidateSize(), 60); renderGeoNames(cells);
  // service
  const vname = D.vehicle && !D.vehicle.auto ? C.vehicleName(D.vehicle) : '';
  const ups = D.maint.map(it => C.nextService([it], D.odo, now)).filter(Boolean).sort((a, b) => b.progress - a.progress);
  if (!ups.length) $('hSvc').innerHTML = `<p class="hint">No service reminders for ${esc(vname || 'your vehicle')} yet.</p><button class="primary small" data-go="service">Set up vehicle &amp; schedule</button>`;
  else { const u = ups[0], nd = C.nextDue(u.item, D.odo, now), cls = u.status.due ? 'red' : (u.status.soon || u.progress >= .85) ? 'am' : 'cy';
    $('hSvc').innerHTML = `<div class="mini">${ringCard(Math.min(100, u.progress * 100), cls, Math.round(Math.min(u.progress, 9.99) * 100) + '%')}<div class="tx"><small>${esc(vname)}</small><br><b>${esc(u.item.name)}</b><br><span class="${u.status.due ? 'due' : u.status.soon ? 'soon' : 'okc'}">${u.status.due ? 'DUE' : u.status.soon ? 'DUE SOON' : 'On track'}</span> <small>${esc(nd ? nd.text : '')}</small></div></div>` +
      ups.slice(1, 3).map(x => { const n2 = C.nextDue(x.item, D.odo, now); return `<div class="sep"></div><div class="item"><div><b>${esc(x.item.name)}</b><br><small>${esc(n2 ? n2.text : '')}</small></div><span class="${x.status.due ? 'due' : x.status.soon ? 'soon' : 'okc'}">${Math.round(Math.min(x.progress, 9.99) * 100)}%</span></div>`; }).join(''); }
  // tyres
  const tp = ['front', 'rear'].filter(p => D.tyres && D.tyres[p] && C.tyreStatus(D.tyres[p], D.odo, now));
  $('hTyre').innerHTML = tp.length ? tp.map((p, i) => { const t = C.tyreStatus(D.tyres[p], D.odo, now); const cls = t.state === 'replace' ? 'red' : t.state === 'watch' ? 'am' : 'cy';
    return (i ? '<div class="sep"></div>' : '') + `<div class="mini">${ringCard(Math.min(100, t.lifePct * 100), cls, Math.round(t.lifePct * 100) + '%')}<div class="tx"><b>${p === 'front' ? 'Front' : 'Rear'} tyre</b> <small>${esc(D.tyres[p].brand || '')}</small><br><span>${fmtNum(t.kmSince)} km since fitted${t.daysSince != null ? ' · ' + t.daysSince + ' d' : ''}</span><br><small>Inspect tread &amp; damage in ${fmtNum(t.kmToCheck)} km (every ${fmtNum(t.checkKm)} km)</small><br>${t.pressureDue ? `<span class="soon">${ico('warn')}Check pressure now</span> <small>(${t.pressureAgo == null ? 'never logged' : t.pressureAgo + ' days ago'}; weekly is typical)</small>` : `<span class="okc">${ico('check')}Pressure checked ${t.pressureAgo} d ago</span>`}${t.state !== 'ok' ? `<br><span class="${t.state === 'replace' ? 'due' : 'soon'}">${t.state === 'replace' ? 'Past typical replace-by guide' : 'Nearing typical replace-by guide'}</span>` : ''}</div></div>`; }).join('') + '<small class="hint">Ring = km since fitted vs a generic 25,000 km guide (not a limit; follow your tyre maker). Wear depends on tread depth, age and damage - inspect by eye.</small>'
    : `<p class="hint">Tell RiderKit when your tyres were fitted to get km-since-fitted, inspection and pressure reminders.</p><button class="primary small" data-go="service">Add tyre details</button>`;
  // docs
  const dl = Object.keys(C.DOC_TYPES).map(k => ({ type: k, name: C.DOC_TYPES[k], expiry: (D.docs[k] || {}).expiry || '' })); const al = C.docAlerts(dl.filter(x => x.expiry), now);
  $('hDocs').innerHTML = al.length ? al.map(a => `<div class="alert-row ${a.state === 'expired' ? 'bad' : ''}"><b>${esc(a.doc.name)}</b><span class="${a.state === 'expired' ? 'due' : 'soon'}">${esc(a.label)}</span></div>`).join('')
    : dl.some(x => x.expiry) ? `<div class="okline">${ico('check')}All documents are valid for 30+ days.</div>` : `<p class="hint">No expiry dates saved yet. Add insurance, PUC, licence and RC dates to get alerts.</p><button class="primary small" data-go="docs">Add expiry dates</button>`;
  // latest ride
  const l = st.last;
  if (!l) $('hLast').innerHTML = '<p class="hint">No rides recorded yet. Your most recent ride will appear here.</p>';
  else { const pts = C.thin(l.points || [], 120); let svg = '';
    if (pts.length > 1) { const la = pts.map(p => p.lat), lo = pts.map(p => p.lon), minA = Math.min(...la), maxA = Math.max(...la), minO = Math.min(...lo), maxO = Math.max(...lo); const k = Math.max(maxA - minA, maxO - minO, 1e-6);
      const w = (maxO - minO) / k * 270, h = (maxA - minA) / k * 70, ox = 150 - w / 2, oy = 45 + h / 2;
      svg = `<svg class="last-prev" viewBox="0 0 300 90" role="img" aria-label="Route shape"><path d="${pts.map((p, i) => (i ? 'L' : 'M') + (ox + (p.lon - minO) / k * 270).toFixed(1) + ' ' + (oy - (p.lat - minA) / k * 70).toFixed(1)).join(' ')}"/></svg>`; }
    $('hLast').innerHTML = svg + `<b>${new Date(l.start).toLocaleDateString('en-IN', { dateStyle: 'medium' })}</b> <small>${new Date(l.start).toLocaleTimeString('en-IN', { timeStyle: 'short' })}</small><div class="kv"><span><b>${C.fmtKm(l.dist)}</b> km</span><span><b>${C.fmtDuration(l.dur || 0)}</b> time</span><span><b>${Math.round(l.avgSpeed || 0)}</b> avg km/h</span><span><b>${Math.round(l.maxSpeed || 0)}</b> max km/h</span></div>` +
      (D.demo ? '<small class="hint">Demo ride</small>' : `<div class="row"><button class="ghost small" id="hLastOpen">View ride</button></div>`); const b = $('hLastOpen'); if (b) b.onclick = () => openRide(l.id); }
  document.querySelectorAll('#tab-home [data-go]').forEach(b => b.onclick = () => showTab(b.dataset.go));
}
// Reverse geocoding: ONLY on tap, Nominatim, >=1.1 s apart, max 10 new lookups per tap, cached forever in IndexedDB.
async function renderGeoNames(cells) {
  const cache = (await kvGet('geocache')) || {}; const names = [...new Set(cells.map(c => cache[c.key]).filter(Boolean))];
  $('geoOut').textContent = names.length ? 'Named areas: ' + names.join(', ') + (names.length < cells.length ? ` (${cells.length - names.length} more cells unnamed)` : '') : '';
  $('geoBtn').hidden = !cells.length;
}
$('geoBtn').onclick = async () => {
  const D = await loadData(); const cells = C.gridCells(D.rides); const cache = (await kvGet('geocache')) || {}; const todo = cells.filter(c => !(c.key in cache)).slice(0, 10);
  if (!todo.length) { $('geoOut').textContent = 'All areas are already named (cached).'; return renderGeoNames(cells); }
  $('geoBtn').disabled = true; let n = 0, failed = false;
  for (const c of todo) { $('geoOut').textContent = `Looking up area ${++n} of ${todo.length}… (OpenStreetMap Nominatim)`;
    try { const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=10&lat=${c.lat.toFixed(4)}&lon=${c.lon.toFixed(4)}`); if (!r.ok) throw new Error('HTTP ' + r.status); const j = await r.json(); const a = j.address || {};
      cache[c.key] = a.city || a.town || a.village || a.suburb || a.county || a.state_district || a.state || (j.display_name || '').split(',')[0] || '(unnamed)'; }
    catch (e) { failed = e.message; break; }
    await new Promise(r => setTimeout(r, 1150)); }
  await kvSet('geocache', cache); $('geoBtn').disabled = false; await renderGeoNames(cells);
  if (failed) $('geoOut').textContent += ' · Lookup stopped: ' + failed + ' (offline or rate-limited). Cached names are kept.';
};
async function setDemo(on) { await kvSet('demo', !!on); renderHome(); }
$('demoToggle').onchange = e => setDemo(e.target.checked); $('demoOff').onclick = () => setDemo(false); $('emptyDemo').onclick = () => setDemo(true);
$('homeStart').onclick = () => { showTab('ride'); if (!ride) $('btnStart').click(); };

// ---------- init ----------
loadSettings(); renderRides(); refreshDocBanner(); renderHome();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(e => console.warn('SW failed', e));
})();
