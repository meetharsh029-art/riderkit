'use strict';
// RiderKit community UI (account-only). Everything user-written is rendered with textContent (never innerHTML). Server enforces every rule; this file is only the front end.
(() => {
  const root = document.getElementById('cmRoot'); if (!root) return;
  const CM = { cfg: null, me: null, section: 'feed', msg: '', busy: false, sections: [], cache: {} };
  window.__CM = CM;
  const tok = () => { try { return localStorage.getItem('rk-auth') || ''; } catch { return ''; } };
  const base = () => (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform() ? 'https://riderkit.onrender.com' : '');
  const goTab = name => { const b = document.querySelector('[data-tab="' + name + '"]'); if (b) b.click(); }; CM.goTab = goTab;
  async function api(method, path, body, raw) {
    const h = {}; if (tok()) h.authorization = 'Bearer ' + tok(); if (body && !raw) h['content-type'] = 'application/json'; if (raw) h['content-type'] = raw;
    const r = await fetch(base() + '/api/community' + path, { method, headers: h, body: raw ? body : body ? JSON.stringify(body) : undefined }); let j = {}; try { j = await r.json(); } catch {}
    if (!r.ok) { const e = new Error(j.error || 'Something went wrong (' + r.status + ')'); e.status = r.status; throw e; } return j; }
  CM.api = api;
  // tiny DOM builder: h('div', {class:'x', onclick:fn}, child, 'text', ...). Strings become text nodes.
  function h(tag, attrs, ...kids) { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs || {})) { if (v == null || v === false) continue; if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (k === 'class') e.className = v; else if (k === 'value') e.value = v; else if (k === 'checked') e.checked = !!v; else e.setAttribute(k, v === true ? '' : v); }
    for (const c of kids.flat()) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c))); return e; }
  CM.h = h;
  const fmtAgo = t => { const s = Math.max(0, (Date.now() - t) / 1000); return s < 60 ? 'now' : s < 3600 ? Math.floor(s / 60) + 'm' : s < 86400 ? Math.floor(s / 3600) + 'h' : Math.floor(s / 86400) + 'd'; }; CM.ago = fmtAgo;
  const AV = { helmet: '\u26d1', bike: '\ud83c\udfcd', scooter: '\ud83d\udef5', car: '\ud83d\ude97', mountain: '\u26f0', road: '\ud83d\udee3', flag: '\ud83c\udfc1', bolt: '\u26a1', compass: '\ud83e\udded', wrench: '\ud83d\udd27', sun: '\u2600', moon: '\ud83c\udf19' };
  const avatar = (a, big) => h('span', { class: 'cm-av' + (big ? ' big' : ''), 'aria-hidden': 'true' }, AV[a] || AV.helmet); CM.avatar = avatar;
  function toast(m, bad) { CM.msg = m; const t = document.getElementById('cmToast'); if (t) { t.textContent = m; t.className = 'cm-toast' + (bad ? ' bad' : ''); t.hidden = !m; clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, 5000); } } CM.toast = toast;
  const run = async (fn, okMsg) => { try { const r = await fn(); if (okMsg) toast(okMsg); return r; } catch (e) { toast(e.message, true); if (e.status === 401) { CM.me = null; } return undefined; } }; CM.run = run;

  // ---- report dialog (every post, comment, profile, club, message)
  CM.report = (kind, id, label) => {
    const reasons = (CM.cfg && CM.cfg.reasons) || ['spam', 'harassment', 'nudity', 'violence', 'dangerous_riding', 'personal_info', 'other'];
    const nice = r => ({ spam: 'Spam or scam', harassment: 'Harassment or hate', nudity: 'Nudity or sexual content', violence: 'Violence', dangerous_riding: 'Dangerous riding / stunts', personal_info: 'Personal info (plates, addresses)', other: 'Something else' }[r] || r);
    const sel = h('select', { id: 'cmRepReason', 'aria-label': 'Reason' }, reasons.map(r => h('option', { value: r }, nice(r)))), note = h('input', { id: 'cmRepNote', placeholder: 'Optional note (max 200)', maxlength: '200', 'aria-label': 'Note' });
    const box = h('div', { class: 'cm-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Report' }, h('div', { class: 'cm-sheet glass' }, h('h3', {}, 'Report ' + (label || kind)), h('p', { class: 'hint' }, 'Reports go to the moderators. The person is not told who reported.'), sel, note,
      h('div', { class: 'row' }, h('button', { class: 'ghost', id: 'cmRepCancel', onclick: () => box.remove() }, 'Cancel'), h('button', { class: 'danger', id: 'cmRepSend', onclick: async () => { const r = await run(() => api('POST', '/report', { kind, id, reason: sel.value, note: note.value }), 'Thanks, we will review it.'); if (r) box.remove(); } }, 'Send report'))));
    document.body.append(box); sel.focus(); };
  CM.confirm = (text, yes, cb) => { const box = h('div', { class: 'cm-modal', role: 'dialog', 'aria-modal': 'true' }, h('div', { class: 'cm-sheet glass' }, h('p', {}, text), h('div', { class: 'row' }, h('button', { class: 'ghost', onclick: () => box.remove() }, 'Cancel'), h('button', { class: 'danger', id: 'cmConfirmYes', onclick: async () => { box.remove(); await cb(); } }, yes)))); document.body.append(box); };

  // ---- screens
  function gate() { return h('div', { class: 'glass card' }, h('h3', {}, 'Community'), h('p', {}, 'Share rides, follow riders, join clubs and chat. You need a free RiderKit account (the rest of the app keeps working as a guest).'),
    h('button', { class: 'primary', id: 'cmGoAcct', onclick: () => goTab('me') }, 'Sign in or create an account')); }
  function joinForm() {
    const hd = h('input', { id: 'cmHandle', placeholder: 'handle (3-20: a-z, 0-9, _)', maxlength: '20', autocapitalize: 'none', autocomplete: 'off', 'aria-label': 'Handle' }), nm = h('input', { id: 'cmName', placeholder: 'Display name (optional)', maxlength: '30', 'aria-label': 'Display name' });
    const a18 = h('input', { type: 'checkbox', id: 'cmAge' }), ru = h('input', { type: 'checkbox', id: 'cmRules' });
    return h('div', { class: 'glass card' }, h('h3', {}, 'Join the community'), h('p', { class: 'hint' }, 'Your profile starts PRIVATE: others only see your handle until you choose otherwise. Your email is never shown. Locations are never shared in posts.'), hd, nm,
      h('label', { class: 'chk' }, a18, h('span', {}, 'I am 18 years old or older.')), h('label', { class: 'chk' }, ru, h('span', {}, 'I accept the ', h('a', { href: 'community-rules.html', target: '_blank', rel: 'noopener' }, 'community rules'), ' and ', h('a', { href: 'terms.html', target: '_blank', rel: 'noopener' }, 'terms'), '.')),
      h('button', { class: 'primary', id: 'cmJoin', onclick: async () => { const r = await run(() => api('POST', '/join', { handle: hd.value, name: nm.value, age18: a18.checked, rules: ru.checked })); if (r) { await load(); } } }, 'Join'),
      h('p', { class: 'hint' }, 'You can delete your account and everything you posted at any time (SOS & settings → Account).')); }
  function profileSection() {
    const p = CM.me.profile, box = h('div', {}); const f = (id, label, val, max, ph) => h('label', { class: 'cm-f' }, h('span', {}, label), h('input', { id, value: val || '', maxlength: String(max), placeholder: ph || '' }));
    const nm = f('cmpName', 'Display name', p.name, 30), bio = f('cmpBio', 'Bio', p.bio, 160, 'Short, no links or phone numbers'), veh = f('cmpVeh', 'Vehicle (optional)', p.vehicle, 40), hd = f('cmpHandle', 'Handle', p.handle, 20);
    const av = h('select', { id: 'cmpAv', 'aria-label': 'Avatar' }, Object.keys(AV).map(k => h('option', { value: k, selected: p.avatar === k }, AV[k] + ' ' + k)));
    const vis = h('select', { id: 'cmpVis', 'aria-label': 'Profile visibility' }, h('option', { value: 'private', selected: p.visibility === 'private' }, 'Private: only handle shown, followers need approval'), h('option', { value: 'public', selected: p.visibility === 'public' }, 'Public: anyone can see my profile and public posts'));
    const dm = h('select', { id: 'cmpDm', 'aria-label': 'Who can message me' }, [['none', 'Nobody can start a chat with me'], ['followers', 'Only riders who follow me'], ['everyone', 'Any rider (not blocked)']].map(([v, t]) => h('option', { value: v, selected: p.dm === v }, t)));
    const ss = h('input', { type: 'checkbox', id: 'cmpStats', checked: p.showStats });
    const save = h('button', { class: 'primary', id: 'cmpSave', onclick: async () => { let stats; if (ss.checked && window.__rk) { try { const rs = await window.__rk.getAll('rides'); const km = rs.reduce((s, r) => s + (+r.dist > 0 ? +r.dist : 0), 0) / 1000; stats = { km, rides: rs.length }; } catch {} }
      const r = await run(() => api('POST', '/profile', { name: nm.querySelector('input').value, bio: bio.querySelector('input').value, vehicle: veh.querySelector('input').value, handle: hd.querySelector('input').value, avatar: av.value, visibility: vis.value, dm: dm.value, showStats: ss.checked, stats }), 'Profile saved'); if (r) { CM.me.profile = r.profile; render(); } } }, 'Save profile');
    box.append(h('div', { class: 'glass card' }, h('div', { class: 'cm-head' }, avatar(p.avatar, true), h('div', {}, h('b', { id: 'cmMeHandle' }, '@' + p.handle), h('div', { class: 'hint' }, p.visibility === 'private' ? 'Private profile' : 'Public profile'))), nm, hd, bio, veh, h('label', { class: 'cm-f' }, h('span', {}, 'Avatar'), av), h('label', { class: 'cm-f' }, h('span', {}, 'Who can see my profile'), vis), h('label', { class: 'cm-f' }, h('span', {}, 'Direct messages'), dm),
      h('label', { class: 'chk' }, ss, h('span', {}, 'Show my lifetime km and ride count on my profile (reported by this phone, not verified)')), save, h('p', { class: 'hint' }, 'Handle can be changed once every 30 days.')));
    const blk = h('div', { class: 'glass card' }, h('h3', {}, 'Blocked riders'), h('div', { id: 'cmBlocks', class: 'hint' }, 'Loading...')); box.append(blk);
    api('GET', '/blocks').then(r => { const d = blk.querySelector('#cmBlocks'); d.textContent = ''; if (!r.blocked.length) d.textContent = 'You have not blocked anyone. Blocked riders cannot see you or contact you, and are not told.'; for (const b of r.blocked) d.append(h('div', { class: 'cm-line' }, h('span', {}, '@' + b.handle), h('button', { class: 'ghost small', onclick: async () => { await run(() => api('POST', '/unblock', { handle: b.handle }), 'Unblocked'); render(); } }, 'Unblock'))); }).catch(() => {});
    box.append(h('div', { class: 'glass card' }, h('h3', {}, 'Your data'), h('div', { class: 'row' }, h('button', { class: 'ghost', id: 'cmExport', onclick: async () => { const d = await run(() => api('GET', '/export')); if (!d) return; const b = new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' }), a = h('a', { href: URL.createObjectURL(b), download: 'riderkit-community-export.json' }); document.body.append(a); a.click(); a.remove(); } }, 'Download my community data'), h('button', { class: 'ghost', onclick: () => goTab('me') }, 'Delete account')),
      h('p', { class: 'hint' }, h('a', { href: 'community-rules.html', target: '_blank', rel: 'noopener' }, 'Community rules'), ' \u00b7 ', h('a', { href: 'store/privacy-policy.html', target: '_blank', rel: 'noopener' }, 'Privacy policy'))));
    return box; }
  CM.sections.push({ id: 'profile', label: 'Me', render: profileSection });

  function render() {
    root.textContent = ''; const toastEl = h('div', { id: 'cmToast', class: 'cm-toast', role: 'status', 'aria-live': 'polite', hidden: true }); root.append(toastEl); if (CM.msg) { /* transient */ }
    if (!CM.cfg) return root.append(h('p', { class: 'hint' }, 'Loading...'));
    if (!CM.cfg.enabled) return root.append(h('div', { class: 'glass card' }, h('h3', {}, 'Community'), h('p', {}, 'The community is not switched on for this server yet.'), CM.cfg.reason ? h('p', { class: 'hint' }, CM.cfg.reason) : null));
    if (!tok()) return root.append(gate());
    if (!CM.me) return root.append(h('p', { class: 'hint' }, 'Loading...'));
    if (!CM.me.joined) return root.append(joinForm());
    const nav = h('div', { class: 'cm-tabs', role: 'tablist' }, CM.sections.map(s => h('button', { role: 'tab', class: CM.section === s.id ? 'on' : '', 'aria-selected': String(CM.section === s.id), id: 'cmTab-' + s.id, onclick: () => { CM.section = s.id; render(); } }, s.label, s.badge ? h('i', { class: 'cm-badge' }, String(s.badge)) : null)));
    root.append(nav); const cur = CM.sections.find(s => s.id === CM.section) || CM.sections[0]; root.append(cur.render());
  }
  CM.render = render;
  async function load() {
    try { CM.cfg = await (await fetch(base() + '/api/community/config')).json(); } catch { CM.cfg = { enabled: false, reason: 'Cannot reach the server.' }; }
    CM.me = null; render(); if (CM.cfg.enabled && tok()) { try { CM.me = await api('GET', '/me'); } catch (e) { if (e.status === 401) { CM.me = null; } } } render(); }
  CM.load = load;
  (window.__rkOnTab = window.__rkOnTab || []).push(n => { if (n === 'community') load(); });
})();
