'use strict';
// Malhiva community UI (account-only). Everything user-written is rendered with textContent (never innerHTML). Server enforces every rule; this file is only the front end.
(() => {
  const root = document.getElementById('cmRoot'); if (!root) return;
  const CM = { cfg: null, me: null, section: 'feed', msg: '', busy: false, sections: [], cache: {} };
  window.__CM = CM;
  const tok = () => { try { return localStorage.getItem('rk-auth') || ''; } catch { return ''; } };
  const base = () => (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform() ? 'https://riderkit.onrender.com' : ''); CM.base = base;
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
  const nz = (...k) => k.flat().filter(c => c != null && c !== false);
  const fmtAgo = t => { const s = Math.max(0, (Date.now() - t) / 1000); return s < 60 ? 'now' : s < 3600 ? Math.floor(s / 60) + 'm' : s < 86400 ? Math.floor(s / 3600) + 'h' : Math.floor(s / 86400) + 'd'; }; CM.ago = fmtAgo;
  const AV = { helmet: '\u26d1', bike: '\ud83c\udfcd', scooter: '\ud83d\udef5', car: '\ud83d\ude97', mountain: '\u26f0', road: '\ud83d\udee3', flag: '\ud83c\udfc1', bolt: '\u26a1', compass: '\ud83e\udded', wrench: '\ud83d\udd27', sun: '\u2600', moon: '\ud83c\udf19' };
  const avatar = (a, big) => h('span', { class: 'cm-av' + (big ? ' big' : ''), 'aria-hidden': 'true' }, AV[a] || AV.helmet); CM.avatar = avatar;
  function toast(m, bad) { CM.msg = m; const ms = document.querySelectorAll('.cm-mtoast'), t = ms.length ? ms[ms.length - 1] : document.getElementById('cmToast'); if (t) { t.textContent = m; t.className = 'cm-toast' + (t.classList.contains('cm-mtoast') ? ' cm-mtoast' : '') + (bad ? ' bad' : ''); t.hidden = !m; clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, 5000); } } CM.toast = toast;
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
  function gate() { return h('div', { class: 'glass card' }, h('h3', {}, 'Community'), h('p', {}, 'Share rides, follow riders, join clubs and chat. You need a free Malhiva account (the rest of the app keeps working as a guest).'),
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
    box.append(...nz(h('div', { class: 'glass card' }, h('div', { class: 'cm-head' }, avatar(p.avatar, true), h('div', {}, h('b', { id: 'cmMeHandle' }, '@' + p.handle), h('div', { class: 'hint' }, p.visibility === 'private' ? 'Private profile' : 'Public profile'))), nm, hd, bio, veh, h('label', { class: 'cm-f' }, h('span', {}, 'Avatar'), av), h('label', { class: 'cm-f' }, h('span', {}, 'Who can see my profile'), vis), h('label', { class: 'cm-f' }, h('span', {}, 'Direct messages'), dm),
      h('label', { class: 'chk' }, ss, h('span', {}, 'Show my lifetime km and ride count on my profile (reported by this phone, not verified)')), save, h('p', { class: 'hint' }, 'Handle can be changed once every 30 days.'))));
    const blk = h('div', { class: 'glass card' }, h('h3', {}, 'Blocked riders'), h('div', { id: 'cmBlocks', class: 'hint' }, 'Loading...')); box.append(...nz(blk));
    api('GET', '/blocks').then(r => { const d = blk.querySelector('#cmBlocks'); d.textContent = ''; if (!r.blocked.length) d.textContent = 'You have not blocked anyone. Blocked riders cannot see you or contact you, and are not told.'; for (const b of r.blocked) d.append(h('div', { class: 'cm-line' }, h('span', {}, '@' + b.handle), h('button', { class: 'ghost small', onclick: async () => { await run(() => api('POST', '/unblock', { handle: b.handle }), 'Unblocked'); render(); } }, 'Unblock'))); }).catch(() => {});
    box.append(...nz(h('div', { class: 'glass card' }, h('h3', {}, 'Your data'), h('div', { class: 'row' }, h('button', { class: 'ghost', id: 'cmExport', onclick: async () => { const d = await run(() => api('GET', '/export')); if (!d) return; const b = new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' }), a = h('a', { href: URL.createObjectURL(b), download: 'riderkit-community-export.json' }); document.body.append(a); a.click(); a.remove(); } }, 'Download my community data'), h('button', { class: 'ghost', onclick: () => goTab('me') }, 'Delete account')),
      h('p', { class: 'hint' }, h('a', { href: 'community-rules.html', target: '_blank', rel: 'noopener' }, 'Community rules'), ' \u00b7 ', h('a', { href: 'store/privacy-policy.html', target: '_blank', rel: 'noopener' }, 'Privacy policy')))));
    return box; }

  // ---- images: client-side downscale + metadata strip (canvas re-encode drops EXIF incl. GPS); the server checks everything again
  const sniffMime = async f => { const b = new Uint8Array(await f.slice(0, 12).arrayBuffer()); if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'; if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'; if (String.fromCharCode(...b.slice(0, 4)) === 'RIFF' && String.fromCharCode(...b.slice(8, 12)) === 'WEBP') return 'image/webp'; return null; };
  const MAX_SIDE = 1600, TARGET = 300 * 1024, HARD = 900 * 1024; CM.MAX_SIDE = MAX_SIDE;
  async function shrinkImage(file) {
    if (file.size > 25e6) throw new Error('That photo is too big (25 MB max before shrinking).');
    const mime = await sniffMime(file); if (!mime && !/^image\/(heic|heif)$/i.test(file.type)) throw new Error('Only JPEG, PNG or WebP photos are supported.');
    let bmp; try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { throw new Error('Could not read that photo on this device.'); }
    const k = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height)), w = Math.max(16, Math.round(bmp.width * k)), h = Math.max(16, Math.round(bmp.height * k)), c = document.createElement('canvas'); c.width = w; c.height = h;
    const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, w, h); x.drawImage(bmp, 0, 0, w, h); if (bmp.close) bmp.close();
    let q = 0.86, blob; for (let i = 0; i < 6; i++) { blob = await new Promise(r => c.toBlob(r, 'image/jpeg', q)); if (!blob) throw new Error('Could not encode the photo.'); if (blob.size <= TARGET) break; q -= 0.12; }
    if (blob.size > HARD) throw new Error('That photo is still too large after shrinking; pick another.'); return { blob, w, h }; }
  CM.shrinkImage = shrinkImage;
  // ---- composer (a ride recap card and/or up to 3 photos + caption)
  const DR = CM.draft = { card: null, stats: null, photos: [], caption: '', vis: '', busy: false };
  const fmtStats = s => s ? [s.km != null ? s.km + ' km' : '', s.dur != null ? (s.dur >= 60 ? Math.floor(s.dur / 60) + ' h ' + (s.dur % 60) + ' min' : s.dur + ' min') : '', s.date || '', s.vehicle || ''].filter(Boolean).join(' \u00b7 ') : ''; CM.fmtStats = fmtStats;
  CM.openComposer = d => { if (d) { DR.card = d.card ? { blob: d.card, url: URL.createObjectURL(d.card) } : DR.card; DR.stats = d.stats || DR.stats; } CM.section = 'compose'; document.querySelector('[data-tab="community"]').click(); setTimeout(() => CM.me ? render() : load(), 50); };
  function composeSection() {
    const p = CM.me.profile, box = h('div', { class: 'glass card' }); const maxP = (CM.cfg.images && CM.cfg.images.maxPhotos) || 3, canImg = !!CM.cfg.images;
    const cap = h('textarea', { id: 'cmCaption', rows: '3', maxlength: '500', placeholder: 'Write a caption (no links or phone numbers)', 'aria-label': 'Caption', oninput: e => { DR.caption = e.target.value; } }); cap.value = DR.caption;
    const vis = h('select', { id: 'cmVis', 'aria-label': 'Who can see this post', onchange: e => { DR.vis = e.target.value; } }, [['followers', 'Followers only'], ...(p.visibility === 'public' ? [['public', 'Public (everyone in the community)']] : []), ...(CM.myClubs || []).map(k => ['club:' + k.id, (k.kind === 'group' ? 'Group: ' : 'Club: ') + k.name + ' (members only)'])].map(([v, t]) => h('option', { value: v, selected: (DR.vis || (p.visibility === 'public' ? 'public' : 'followers')) === v }, t)));
    const thumbs = h('div', { class: 'cm-thumbs' }); const drawThumbs = () => { thumbs.textContent = ''; if (DR.card) thumbs.append(h('div', { class: 'cm-th' }, h('img', { src: DR.card.url, alt: 'Ride card' }), h('button', { class: 'ghost', 'aria-label': 'Remove ride card', onclick: () => { DR.card = null; DR.stats = null; render(); } }, '\u00d7')));
      DR.photos.forEach((ph, i) => thumbs.append(h('div', { class: 'cm-th' }, h('img', { src: ph.url, alt: 'Photo ' + (i + 1) }), h('button', { class: 'ghost', 'aria-label': 'Remove photo ' + (i + 1), onclick: () => { DR.photos.splice(i, 1); drawThumbs(); } }, '\u00d7')))); }; drawThumbs();
    const file = h('input', { type: 'file', id: 'cmFile', accept: 'image/jpeg,image/png,image/webp', multiple: true, 'aria-label': 'Add photos', hidden: true, onchange: async e => { for (const f of [...e.target.files]) { if (DR.photos.length >= maxP) { toast('Up to ' + maxP + ' photos per post.', true); break; } const r = await run(() => shrinkImage(f)); if (r) DR.photos.push({ blob: r.blob, url: URL.createObjectURL(r.blob), w: r.w, h: r.h }); } e.target.value = ''; drawThumbs(); } });
    const post = h('button', { class: 'primary', id: 'cmPost', onclick: async () => { if (DR.busy) return; DR.busy = true; post.disabled = true; post.textContent = 'Posting...';
      try { const ids = []; let cardId = null; if (DR.card) cardId = DR.card.id || (DR.card.id = (await api('POST', '/upload?kind=card', DR.card.blob, DR.card.blob.type || 'image/jpeg')).id); for (const ph of DR.photos) ids.push(ph.id || (ph.id = (await api('POST', '/upload?kind=photo', ph.blob, 'image/jpeg')).id)); // uploaded once; a failed post (e.g. a link in the caption) reuses the ids
        const r = await api('POST', '/posts', { caption: cap.value, card: cardId, photos: ids, stats: DR.stats, vis: vis.value.startsWith('club:') ? 'club' : vis.value, club: vis.value.startsWith('club:') ? vis.value.slice(5) : undefined }); DR.card = null; DR.stats = null; DR.photos = []; DR.caption = ''; CM.section = 'feed'; FD.loaded = false; toast(r.held ? 'Posted, but held for review before others can see it.' : 'Posted!'); render();
      } catch (e) { toast(e.message, true); post.disabled = false; post.textContent = 'Post'; } finally { DR.busy = false; } } }, 'Post');
    box.append(...nz(h('h3', {}, 'New post'), DR.stats ? h('div', { class: 'hint', id: 'cmStatsLine' }, 'Ride summary: ' + fmtStats(DR.stats)) : null, thumbs, cap,
      canImg ? h('div', { class: 'row' }, h('button', { class: 'ghost', id: 'cmAddPhoto', onclick: () => file.click() }, 'Add photos (' + DR.photos.length + '/' + maxP + ')'), file) : h('p', { class: 'hint' }, 'Photo uploads are not available on this server yet.'),
      h('p', { class: 'cm-warn' }, 'Photos can show your home, street signs or number plates. Check before you post. Malhiva shrinks photos and removes hidden location data (EXIF), but cannot blur plates. Posts never include GPS points.'),
      h('label', { class: 'cm-f' }, h('span', {}, 'Audience'), vis), p.visibility !== 'public' ? h('p', { class: 'hint' }, 'Your profile is private, so posts go to your followers only. Make it public in Me to post publicly.') : null,
      h('p', { class: 'hint' }, 'By posting you agree to the ', h('a', { href: 'community-rules.html', target: '_blank', rel: 'noopener' }, 'community rules'), '.'), post)); return box; }
  CM.sections.push({ id: 'compose', label: 'Post', render: composeSection });
  // ---- feed
  const FD = CM.feed = { scope: 'global', posts: [], next: null, loading: false, loaded: false, error: '' };
  function openImage(url) { const box = h('div', { class: 'cm-modal', role: 'dialog', 'aria-label': 'Photo', onclick: () => box.remove() }, h('img', { src: url, alt: 'Photo', style: 'max-width:100%;max-height:90vh;border-radius:12px' })); document.body.append(box); }
  CM.extraActions = []; // later stages add [fn(post) => node]
  function postCard(p, onChange) {
    const st = fmtStats(p.stats), card = h('article', { class: 'glass cm-post', 'data-post': p.id });
    const menu = h('div', { class: 'cm-actions' }); card.append(h('div', { class: 'cm-meta' }, avatar(p.author.avatar), h('div', {}, h('b', {}, p.author.name), h('small', {}, '@' + p.author.handle + ' \u00b7 ' + fmtAgo(p.at) + (p.vis === 'followers' ? ' \u00b7 followers' : p.vis === 'club' ? ' \u00b7 club' : '')))));
    if (p.state) card.append(h('div', { class: 'cm-warn' }, p.state === 'held' ? 'Held for review: only you can see this.' : 'Hidden by moderation: only you can see this.'));
    if (p.images.card) card.append(h('img', { class: 'cm-img', src: base() + p.images.card, alt: 'Ride card', loading: 'lazy', onclick: () => openImage(base() + p.images.card) })); if (st) card.append(h('div', { class: 'hint' }, st));
    if (p.caption) card.append(h('div', { class: 'cm-caption' }, p.caption)); if (p.images.photos.length) card.append(h('div', { class: 'cm-photos' }, p.images.photos.map((u, i) => h('img', { src: base() + u, alt: 'Photo ' + (i + 1), loading: 'lazy', onclick: () => openImage(base() + u) }))));
    for (const f of CM.extraActions) { const n = f(p, card, onChange, menu); if (n) menu.append(n); }
    if (p.mine) menu.append(h('button', { class: 'ghost small', 'data-act': 'delete', onclick: () => CM.confirm('Delete this post and its photos?', 'Delete', async () => { if (await run(() => api('POST', '/posts/' + p.id + '/delete'), 'Post deleted')) onChange(p, null); }) }, 'Delete'));
    else { menu.append(h('button', { class: 'ghost small', 'data-act': 'report', onclick: () => CM.report('post', p.id, 'post') }, 'Report'), h('button', { class: 'ghost small', 'data-act': 'block', onclick: () => CM.confirm('Block @' + p.author.handle + '? You will not see each other.', 'Block', async () => { if (await run(() => api('POST', '/block', { handle: p.author.handle }), 'Blocked')) { FD.loaded = false; render(); } }) }, 'Block')); }
    card.append(menu); return card; }
  CM.postCard = postCard;
  async function loadFeed(more) { if (FD.loading) return; FD.loading = true; if (!more) { FD.posts = []; FD.next = null; } try { const r = await api('GET', '/feed?scope=' + FD.scope + (more && FD.next ? '&before=' + encodeURIComponent(FD.next) : '') + '&limit=20'); FD.posts.push(...r.posts); FD.next = r.next; FD.error = ''; } catch (e) { FD.error = e.message; } FD.loaded = true; FD.loading = false; if (CM.section === 'feed') render(); }
  function feedSection() {
    const box = h('div', {}); if (!FD.loaded && !FD.loading) loadFeed(false);
    box.append(...nz(h('div', { class: 'row' }, ['global', 'following'].map(s => h('button', { class: (FD.scope === s ? 'primary' : 'ghost') + ' small', id: 'cmScope-' + s, onclick: () => { FD.scope = s; FD.loaded = false; render(); } }, s === 'global' ? 'Everyone' : 'Following')))));
    const list = h('div', { id: 'cmFeed' }); if (FD.error) list.append(h('p', { class: 'hint' }, FD.error));
    for (const p of FD.posts) list.append(postCard(p, (old, nw) => { FD.posts = FD.posts.filter(x => x.id !== old.id); render(); })); if (FD.loading) list.append(h('p', { class: 'hint' }, 'Loading...'));
    else if (!FD.posts.length && FD.loaded) list.append(h('div', { class: 'glass card', id: 'cmEmpty' }, h('p', {}, FD.scope === 'global' ? 'No public posts yet. Be the first: finish a ride, open it in History and tap "Share recap card", then "Post to community".' : 'Nothing from riders you follow yet.'), h('button', { class: 'primary', onclick: () => { CM.section = 'compose'; render(); } }, 'Write a post')));
    if (FD.next && !FD.loading) list.append(h('button', { class: 'ghost', id: 'cmMore', onclick: () => loadFeed(true) }, 'Load more')); box.append(...nz(list)); return box; }
  CM.sections.unshift({ id: 'feed', label: 'Feed', render: feedSection });
  // recap card -> "Post to community" (button added to the existing recap dialog when it appears)
  const addRecapBtn = () => { const m = document.getElementById('recapModal'); if (!m || m.querySelector('#rcPost')) return; const box = m.querySelector('.recap-box'); if (!box) return;
    const btn = h('button', { class: 'ghost', id: 'rcPost', type: 'button', onclick: async () => { const RC = window.__rkRC; if (!RC || !RC.canvas) return; let blob = null; for (const q of [0.9, 0.8, 0.65]) { blob = await new Promise(r => RC.canvas.toBlob(r, 'image/jpeg', q)); if (blob && blob.size <= 700 * 1024) break; } const ride = RC.ride || {};
      const d = new Date(ride.start || Date.now()), pad = n => String(n).padStart(2, '0'); const stats = { km: Math.round((ride.dist || 0) / 100) / 10, dur: Math.round((ride.dur || 0) / 60), date: d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) }; if (ride.vehicleName) stats.vehicle = String(ride.vehicleName).slice(0, 40);
      const cl = m.querySelector('#rcClose'); if (cl) cl.click(); CM.openComposer({ card: blob, stats }); } }, 'Post to community'); const share = box.querySelector('#rcShare'); (share && share.parentNode ? share.parentNode : box).append(btn); };
  new MutationObserver(addRecapBtn).observe(document.body, { childList: true }); addRecapBtn();

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
