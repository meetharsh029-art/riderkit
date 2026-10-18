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
})();
