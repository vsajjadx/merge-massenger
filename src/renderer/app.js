const api = window.messenger;
const $ = (s) => document.querySelector(s);

const state = {
  chats: new Map(), active: null, messages: [], statuses: {}, pending: [], search: '',
  downloading: new Set(), loadingOlder: false, modalShown: false, filter: null,
  view: 'all', loading: true, webStatuses: {}, preferences: { theme: 'dark', compact: false },
};
let icons = {};
try { icons = JSON.parse(localStorage.getItem('icons') || '{}'); } catch { icons = {}; }
let avatars = {}; // profile pictures of the web chats (data URLs), remembered between runs
try { avatars = JSON.parse(localStorage.getItem('avatars') || '{}'); } catch { avatars = {}; }
let avatarSave = null;
function saveAvatars() {
  clearTimeout(avatarSave);
  avatarSave = setTimeout(() => {
    const keys = Object.keys(avatars);
    if (keys.length > 300) for (const k of keys.slice(0, keys.length - 300)) delete avatars[k];
    try { localStorage.setItem('avatars', JSON.stringify(avatars)); } catch { /* storage full */ }
  }, 2000);
}
const SOURCE = { tg: 'Telegram', wa: 'WhatsApp', ei: 'Eitaa', ba: 'Bale', ru: 'Rubika' };

// ---------- helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const linkify = (s) => esc(s).replace(/\bhttps?:\/\/[^\s<]+/g, (u) => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`);
const fileUrl = (p) => encodeURI('file:///' + p.replace(/\\/g, '/').replace(/^\//, '')).replace(/\?/g, '%3F').replace(/#/g, '%23');
const baseName = (p) => p.split(/[\\/]/).pop();

function size(n) {
  if (!n) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < 3) { n /= 1024; i++; }
  return `${n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)} ${u[i]}`;
}
function clock(ts) { return new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
function listTime(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000), now = new Date();
  if (d.toDateString() === now.toDateString()) return clock(ts);
  if (now - d < 6 * 864e5) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { day: 'numeric', month: 'short', year: d.getFullYear() === now.getFullYear() ? undefined : '2-digit' });
}
function dayLabel(ts) {
  const d = new Date(ts * 1000), now = new Date();
  if (d.toDateString() === now.toDateString()) return 'Today';
  if (new Date(now - 864e5).toDateString() === d.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}
function hue(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }
// Logos: Telegram and WhatsApp are the marks drawn in the rail, the others use the icon read from their own page.
const logoPath = (k) => { const p = document.querySelector(`.rail-btn[data-svc="${k}"] .logo svg path`); return p ? p.getAttribute('d') : ''; };
function badgeHtml(base, second) {
  const d = (base === 'tg' || base === 'wa') ? logoPath(base) : '';
  const letter = { tg: 'T', wa: 'W', ei: 'E', ba: 'B', ru: 'R' }[base] || '?';
  const inner = d ? `<svg viewBox="0 0 24 24"><path d="${d}"/></svg>` : icons[base] ? `<img src="${esc(icons[base])}" alt="">` : letter;
  return inner + (second ? '<i>2</i>' : '');
}
function avatar(chat, extra = '') {
  const initials = (chat.title || '?').trim().split(/\s+/).slice(0, 2).map((w) => [...w][0]).join('').toUpperCase() || '?';
  const base = chat.source.replace(/2$/, '');
  const second = base !== chat.source;
  const photo = chat.avatar ? `<img class="ph" src="${esc(chat.avatar)}" alt="">` : '';
  return `<div class="avatar ${extra}" style="background:hsl(${hue(chat.id)} 45% 42%)">${esc(initials)}${photo}<span class="src ${base} ${second ? 'second' : ''}">${badgeHtml(base, second)}</span></div>`;
}
// a picture that cannot be shown falls back to the initials
document.addEventListener('error', (e) => { if (e.target && e.target.classList && e.target.classList.contains('ph')) e.target.remove(); }, true);
const PIN = '<svg class="pin" viewBox="0 0 24 24"><path d="M16 9V4h1a1 1 0 0 0 0-2H7a1 1 0 0 0 0 2h1v5a3 3 0 0 1-2 2.8V13h5v7l1 2 1-2v-7h5v-1.2A3 3 0 0 1 16 9z"/></svg>';

let toastTimer;
function toast(text) {
  const t = $('#toast');
  t.textContent = String(text).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 4500);
}
const guard = (p) => p.catch((e) => toast(e.message || e));

// ---------- dates of web chats ----------
// The web clients only show a short label next to each chat (a clock time, a weekday, a date in the
// Gregorian or the Jalali calendar). It is turned into a real timestamp so the chats of all services
// can be put in one order by date.
function jalaliToGregorian(jy, jm, jd) {
  jy += 1595;
  let days = -355668 + 365 * jy + Math.floor(jy / 33) * 8 + Math.floor(((jy % 33) + 3) / 4) + jd + (jm < 7 ? (jm - 1) * 31 : (jm - 7) * 30 + 186);
  let gy = 400 * Math.floor(days / 146097);
  days %= 146097;
  if (days > 36524) { gy += 100 * Math.floor(--days / 36524); days %= 36524; if (days >= 365) days++; }
  gy += 4 * Math.floor(days / 1461);
  days %= 1461;
  if (days > 365) { gy += Math.floor((days - 1) / 365); days = (days - 1) % 365; }
  let gd = days + 1;
  const leap = (gy % 4 === 0 && gy % 100 !== 0) || gy % 400 === 0;
  const len = [0, 31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  let gm = 1;
  while (gm <= 12 && gd > len[gm]) gd -= len[gm++];
  return [gy, gm, gd];
}
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WEEKDAYS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, یکشنبه: 0, دوشنبه: 1, سهشنبه: 2, چهارشنبه: 3, پنجشنبه: 4, جمعه: 5, شنبه: 6 };
const dayFirst = (() => {
  try {
    const order = new Intl.DateTimeFormat(navigator.language).formatToParts(new Date(2000, 10, 25)).filter((p) => p.type === 'day' || p.type === 'month').map((p) => p.type);
    return order[0] === 'day';
  } catch { return false; }
})();

// Returns { ts, exact } with ts in seconds; exact is false when the label said nothing about the day.
function webTimestamp(label, rank) {
  const now = new Date();
  const dayStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const today = dayStart(now);
  const sec = (d) => d.getTime() / 1000;
  // date only: noon minus the rank keeps the order the service itself shows within that day
  const atDay = (d) => sec(d) + 43200 - rank;
  const t = String(label || '').trim();
  let m = /^(\d{1,2}):(\d{2})\s?([ap]m)?$/i.exec(t);
  if (m) {
    let h = Number(m[1]);
    if (m[3] && /pm/i.test(m[3]) && h < 12) h += 12;
    if (m[3] && /am/i.test(m[3]) && h === 12) h = 0;
    return { ts: sec(today) + h * 3600 + Number(m[2]) * 60, exact: true };
  }
  const key = t.toLowerCase().replace(/[\u200c\s.]/g, '');
  if (key === 'today' || key === 'امروز') return { ts: atDay(today), exact: true };
  if (key === 'yesterday' || key === 'دیروز') return { ts: atDay(new Date(today.getTime() - 864e5)), exact: true };
  if (key in WEEKDAYS) {
    const back = ((today.getDay() - WEEKDAYS[key] + 6) % 7) + 1; // the latest such day before today
    return { ts: atDay(new Date(today.getFullYear(), today.getMonth(), today.getDate() - back)), exact: true };
  }
  m = /^(\d{1,4})[\/.\-](\d{1,2})(?:[\/.\-](\d{1,4}))?$/.exec(t);
  if (m) {
    let [a, b, c] = [Number(m[1]), Number(m[2]), m[3] === undefined ? null : Number(m[3])];
    let y, mo, d;
    if (m[1].length === 4 || a > 31) { y = a; mo = b; d = c || 1; }           // year first
    else if (c === null) { mo = dayFirst ? b : a; d = dayFirst ? a : b; y = now.getFullYear(); } // day and month only
    else {
      y = c < 100 ? 2000 + c : c;
      if (a > 12) { d = a; mo = b; } else if (b > 12) { mo = a; d = b; } else if (dayFirst) { d = a; mo = b; } else { mo = a; d = b; }
    }
    if (y >= 1300 && y < 1700) [y, mo, d] = jalaliToGregorian(y, mo, d);
    const date = new Date(y, mo - 1, d);
    if (!isNaN(date)) return { ts: atDay(date), exact: true };
  }
  m = /^(\d{1,2})\s?([a-z]{3,})\.?(?:\s(\d{2,4}))?$/i.exec(t) || (() => { const x = /^([a-z]{3,})\.?\s(\d{1,2})(?:,?\s(\d{2,4}))?$/i.exec(t); return x && [x[0], x[2], x[1], x[3]]; })();
  if (m) {
    const mi = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase());
    if (mi >= 0) {
      let y = m[3] ? Number(m[3]) : now.getFullYear();
      if (y < 100) y += 2000;
      let date = new Date(y, mi, Number(m[1]));
      if (!m[3] && date > now) date = new Date(y - 1, mi, Number(m[1]));
      return { ts: atDay(date), exact: true };
    }
  }
  // unknown label: below today's chats, in the order the service shows them
  return { ts: sec(today) - (rank + 1) * 60, exact: false };
}

// ---------- pinned chats of the web clients (kept in this window's local storage) ----------
let pins = [];
try { pins = JSON.parse(localStorage.getItem('pins') || '[]'); } catch { pins = []; }
function applyPin(c) { const i = pins.indexOf(c.id); c.pinned = i >= 0; c.pinOrder = i >= 0 ? i : 0; }
function togglePin(id) {
  const i = pins.indexOf(id);
  if (i >= 0) pins.splice(i, 1); else pins.push(id);
  try { localStorage.setItem('pins', JSON.stringify(pins)); } catch { /* storage unavailable */ }
  const c = state.chats.get(id);
  if (c) applyPin(c);
  renderList();
}

// ---------- chat list ----------
// byService: the sidebar shows only the messenger picked on the rail; All (no pick) and the feed show every messenger.
// Archived chats are not part of the normal lists: a messenger picked on the rail has an Archive entry
// at the top of its list, which opens the archive (with a Back entry); All never shows archived chats.
state.archiveOpen = false;
function setFilter(key) { state.filter = key; state.archiveOpen = false; }

function sortedChats(byService = true) {
  const q = state.search.trim().normalize('NFKC').toLowerCase();
  return [...state.chats.values()]
    .filter((c) => {
      if (byService && state.filter && c.source !== state.filter) return false;
      const showArchive = state.view === 'archived' || (byService && state.filter && state.archiveOpen);
      if (!!c.archived !== !!showArchive) return false;
      if (state.view === 'unread' && !c.unread) return false;
      if (state.view === 'pinned' && !c.pinned) return false;
      const searchable = `${c.title || ''} ${c.lastText || ''} ${SOURCE[c.source.replace(/2$/, '')] || ''}`.normalize('NFKC').toLowerCase();
      return (c.pinned || c.lastTs > 0) && (!q || searchable.includes(q));
    })
    .sort((a, b) => (b.pinned - a.pinned) || (a.pinned ? a.pinOrder - b.pinOrder : 0) || (b.lastTs - a.lastTs));
}

function emptyChats(full = false) {
  if (state.loading) return `<div class="empty-state ${full ? 'large' : ''}"><div class="loading-ring"></div><h3>Preparing your workspace</h3><p>Connecting your messengers…</p></div>`;
  if (state.search.trim()) return `<div class="empty-state ${full ? 'large' : ''}"><div class="empty-icon">⌕</div><h3>No matching conversations</h3><p>Try another name, messenger, or message preview.</p><button class="btn ghost" data-clear-search>Clear search</button></div>`;
  if (state.view !== 'all' || state.archiveOpen) {
    const label = state.archiveOpen ? 'archived' : state.view;
    return `<div class="empty-state ${full ? 'large' : ''}"><div class="empty-icon">${label === 'unread' ? '✓' : label === 'pinned' ? '◇' : '▤'}</div><h3>${label === 'unread' ? 'You’re all caught up' : `No ${label} conversations`}</h3><p>${label === 'pinned' ? 'Right-click a conversation and choose Pin to top.' : label === 'unread' ? 'Unread conversations will appear here.' : 'Archived chats appear after they are available in your messenger.'}</p></div>`;
  }
  return `<div class="empty-state ${full ? 'large' : ''}"><h3>No conversations yet</h3><p>Sign in to a messenger to get started.</p><button class="text-btn" data-connect>Connect a messenger</button></div>`;
}

function updateWorkspaceStatus() {
  const offline = navigator.onLine === false;
  $('#networkBanner').hidden = !offline;
  const known = Object.values(state.webStatuses);
  const ready = known.filter((s) => s.state === 'ready' || s.state === 'loaded').length;
  const errors = known.filter((s) => s.state === 'error').length;
  const label = offline ? 'You are offline' : ready ? `${ready} messenger${ready === 1 ? '' : 's'} available` : errors ? 'Some services need attention' : state.loading ? 'Preparing workspace' : 'Ready to connect';
  $('#connectionStatus').innerHTML = `<i class="${offline || errors && !ready ? 'warn' : ready ? 'ready' : ''}"></i>${label}`;
}

let listQueued = false;
function renderList() {
  if (listQueued) return;
  listQueued = true;
  requestAnimationFrame(() => {
    listQueued = false;
    const chats = sortedChats();
    let html = '';
    if (state.filter && state.archiveOpen) html += '<button class="arc-row" data-arc="0"><span class="arc-ic">←</span>Back to conversations</button>';
    else if (state.filter && state.view === 'all') {
      const n = [...state.chats.values()].filter((c) => c.source === state.filter && c.archived).length;
      if (n) html += `<button class="arc-row" data-arc="1"><span class="arc-ic">▣</span>Archive<span class="n">${n}</span></button>`;
    }
    let wasPinned = false;
    chats.forEach((c, i) => {
      if (wasPinned && !c.pinned) html += '<div class="divider"></div>';
      wasPinned = c.pinned;
      const last = (c.archived ? '<span class="arc">Archived</span>' : '') + (c.lastOut ? `<span class="you">You: </span>${esc(c.lastText)}` : esc(c.lastText));
      html += `<div class="chat-item ${c.id === state.active ? 'active' : ''}" data-id="${esc(c.id)}" tabindex="0" role="button" aria-label="${esc(c.title)}${c.unread ? ', unread' : ''}" aria-pressed="${c.id === state.active}">
        ${avatar(c)}
        <div class="c-body">
          <div class="c-row"><div class="c-title">${esc(c.title || 'Unknown')}</div><div class="c-time">${esc(c.timeText) || listTime(c.lastTs)}</div></div>
          <div class="c-row"><div class="c-last">${last}</div>${c.unread ? `<div class="badge">${c.unread}</div>` : c.pinned ? PIN : ''}</div>
        </div></div>`;
    });
    $('#chatList').innerHTML = html + (!chats.length ? emptyChats() : '');
    $('#listCount').textContent = chats.length;
    $('#listHeading').textContent = state.search ? 'Search results' : state.filter ? SOURCE[state.filter.replace(/2$/, '')] : `${state.view === 'all' ? 'All' : state.view[0].toUpperCase() + state.view.slice(1)} conversations`;
    const allChats = [...state.chats.values()].filter((c) => !c.archived);
    const unread = allChats.reduce((sum, c) => sum + Math.max(0, Number(c.unread) || 0), 0);
    $('#totalBadge').textContent = unread > 999 ? '999+' : unread;
    $('#totalBadge').hidden = !unread;
    if (state.lastUnread !== unread) { state.lastUnread = unread; if (api.setUnread) guard(api.setUnread(unread)); }
    updateWorkspaceStatus();
    renderFeed();
  });
}

// ---------- "All": every messenger in one list, newest first ----------
function renderFeed() {
  // The unified chat list lives in the sidebar. Keep the conversation area quiet until a chat opens.
  $('#feedList').innerHTML = '<div class="conversation-placeholder"><svg viewBox="0 0 48 48" aria-hidden="true"><path d="M12 9h24a6 6 0 0 1 6 6v17a6 6 0 0 1-6 6H22l-10 5v-5a6 6 0 0 1-6-6V15a6 6 0 0 1 6-6Z"/><path d="M16 20h16M16 27h10"/></svg><h2>Select a conversation</h2><p>Choose a chat from the list to start messaging.</p><button class="text-btn" data-connect>Connect a messenger</button></div>';
}
$('#listFilters').addEventListener('click', (e) => {
  const button = e.target.closest('[data-view]');
  if (!button) return;
  state.view = button.dataset.view;
  state.archiveOpen = false;
  document.querySelectorAll('[data-view]').forEach((b) => { b.classList.toggle('active', b === button); b.setAttribute('aria-pressed', String(b === button)); });
  renderList();
});
for (const el of [$('#chatList'), $('#feedList')]) {
  el.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.chat-item')) { e.preventDefault(); openChat(e.target.dataset.id); } });
  el.addEventListener('click', (e) => { if (e.target.closest('[data-connect]')) openModal('accounts'); if (e.target.closest('[data-clear-search]')) { state.search = ''; $('#search').value = ''; renderList(); $('#search').focus(); } });
}
$('#chatList').addEventListener('click', (e) => {
  const r = e.target.closest('[data-arc]');
  if (r) { state.archiveOpen = r.dataset.arc === '1'; renderList(); }
});
$('#feedList').addEventListener('click', (e) => {
  const item = e.target.closest('.chat-item');
  if (item) openChat(item.dataset.id);
});

// ---------- messages ----------
function mediaHtml(m) {
  const md = m.media;
  const ready = !!m.localPath;
  const busy = state.downloading.has(m.id);
  const attrs = `data-msg="${esc(m.id)}" ${ready ? 'draggable="true" title="Drag me out to save the file"' : ''}`;
  if (md.kind === 'image' || md.kind === 'sticker' || (md.thumb && md.kind === 'video')) {
    const src = ready && md.kind !== 'video' ? fileUrl(m.localPath) : md.thumb;
    if (src) {
      const label = ready ? (md.kind === 'video' ? 'Play' : '') : busy ? 'Downloading…' : `Download ${size(md.size)}`;
      return `<div class="media is-image ${ready ? 'ready' : 'pending'}" ${attrs}><img src="${esc(src)}" draggable="false">${label ? `<div class="overlay"><span>${label}</span></div>` : ''}</div>`;
    }
  }
  const icon = { image: 'IMG', video: 'VID', voice: 'MIC', audio: 'AUD', sticker: 'STK', file: 'FILE' }[md.kind] || 'FILE';
  const sub = busy ? 'Downloading…' : ready ? `${size(md.size)} · click to open` : `${size(md.size)} · click to download`;
  return `<div class="media ${ready ? 'ready' : ''}" ${attrs}><div class="m-icon">${icon}</div><div><div class="m-name">${esc(md.name)}</div><div class="m-sub">${sub}</div></div></div>`;
}

function renderMessages(mode) {
  const box = $('#messages');
  const chat = state.chats.get(state.active);
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  const prevHeight = box.scrollHeight, prevTop = box.scrollTop;
  let html = '', lastDay = '', lastSender = null;
  for (const m of state.messages) {
    const day = new Date(m.ts * 1000).toDateString();
    if (day !== lastDay) { html += `<div class="day">${dayLabel(m.ts)}</div>`; lastDay = day; lastSender = null; }
    const key = m.out ? '__me' : m.sender;
    const first = key !== lastSender;
    lastSender = key;
    const who = first && chat && chat.isGroup && !m.out && m.sender ? `<div class="who">${esc(m.sender)}</div>` : '';
    html += `<div class="msg ${m.out ? 'out' : ''} ${first ? 'first' : ''}" data-id="${esc(m.id)}">${who}${m.media ? mediaHtml(m) : ''}${m.text ? `<div class="txt">${linkify(m.text)}</div>` : ''}<span class="time">${clock(m.ts)}</span></div>`;
  }
  box.innerHTML = html;
  if (mode === 'bottom' || (mode === 'keep' && nearBottom)) box.scrollTop = box.scrollHeight;
  else if (mode === 'prepend') box.scrollTop = prevTop + (box.scrollHeight - prevHeight);
  else box.scrollTop = prevTop;
}

function upsertMessage(m) {
  const i = state.messages.findIndex((x) => x.id === m.id);
  if (i >= 0) { state.messages[i] = m; return false; }
  state.messages.push(m);
  state.messages.sort((a, b) => a.ts - b.ts);
  return true;
}

async function openChat(id) {
  const web = state.chats.get(id);
  if (web && web.web) {
    state.active = id;
    $('#feed').hidden = true;
    $('#chatView').hidden = true;
    markRail(web.source);
    renderList();
    return guard(api.openWebChat(web.source, web.title, web.n, !!web.archived));
  }
  state.active = id;
  state.pending = [];
  renderPending();
  const chat = state.chats.get(id);
  $('#feed').hidden = true;
  $('#chatView').hidden = false;
  $('#hAvatar').outerHTML = avatar(chat).replace('class="avatar ', 'id="hAvatar" class="avatar ');
  $('#hTitle').textContent = chat.title;
  $('#hSub').textContent = SOURCE[chat.source] + (chat.isGroup ? ' · group' : '');
  state.messages = await guard(api.openChat(id)) || [];
  renderMessages('bottom');
  renderList();
  $('#input').focus();
}

// ---------- composer, pending files ----------
function renderPending() {
  const el = $('#pending');
  el.hidden = !state.pending.length;
  el.innerHTML = state.pending.map((p, i) => `<div class="chip"><span>${esc(baseName(p))}</span><button data-rm="${i}" title="Remove">&times;</button></div>`).join('');
}
function addPending(paths) {
  for (const p of paths) if (p && !state.pending.includes(p)) state.pending.push(p);
  renderPending();
}

async function send() {
  const id = state.active;
  if (!id) return;
  const input = $('#input');
  const text = input.value.trim();
  if (!text && !state.pending.length) return;
  const files = state.pending;
  input.value = '';
  input.style.height = '';
  state.pending = [];
  renderPending();
  try {
    if (files.length) await api.sendFiles(id, files, text);
    else await api.sendText(id, text);
  } catch (e) {
    toast(e.message || e);
    input.value = text; // give the text back so nothing is lost
    state.pending = files;
    renderPending();
  }
}

$('#sendBtn').onclick = send;
$('#attachBtn').onclick = async () => addPending(await api.pickFiles());
$('#input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});
$('#input').addEventListener('input', (e) => {
  e.target.style.height = 'auto';
  e.target.style.height = Math.min(e.target.scrollHeight, 160) + 'px';
});
$('#pending').addEventListener('click', (e) => {
  const rm = e.target.closest('[data-rm]');
  if (rm) { state.pending.splice(Number(rm.dataset.rm), 1); renderPending(); }
});

// ---------- drag and drop in (files from Explorer, or from another chat of this app) ----------
let dragDepth = 0;
const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  dragDepth++;
  $('#dropText').textContent = state.active ? `Drop files to send to ${state.chats.get(state.active).title}` : 'Open a chat first';
  $('#drop').hidden = !state.active;
});
window.addEventListener('dragleave', (e) => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; $('#drop').hidden = true; } });
window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('#drop').hidden = true;
  if (!state.active || !hasFiles(e)) return;
  addPending([...e.dataTransfer.files].map((f) => api.pathForFile(f)));
  $('#input').focus();
});

// ---------- drag and drop out ----------
$('#messages').addEventListener('dragstart', (e) => {
  const el = e.target.closest('.media[draggable="true"]');
  if (!el) return;
  const m = state.messages.find((x) => x.id === el.dataset.msg);
  e.preventDefault(); // hand over to the native file drag started by the main process
  if (m && m.localPath) api.startDrag(m.localPath);
});

// ---------- clicks: media, chat list, menus ----------
async function downloadMedia(id) {
  if (state.downloading.has(id)) return;
  state.downloading.add(id);
  renderMessages('keep');
  try { return await api.download(id); }
  catch (e) { toast(e.message || e); }
  finally { state.downloading.delete(id); renderMessages('keep'); }
}

$('#messages').addEventListener('click', async (e) => {
  const el = e.target.closest('.media');
  if (!el) return;
  const m = state.messages.find((x) => x.id === el.dataset.msg);
  if (!m) return;
  if (m.localPath) guard(api.openFile(m.localPath));
  else {
    const done = await downloadMedia(m.id);
    if (done) { upsertMessage(done); renderMessages('keep'); }
  }
});

$('#chatList').addEventListener('click', (e) => {
  const item = e.target.closest('.chat-item');
  if (item) openChat(item.dataset.id);
});
$('#search').addEventListener('input', (e) => { state.search = e.target.value; renderList(); });

function showMenu(x, y, entries) {
  const menu = $('#menu');
  menu.innerHTML = entries.map((en, i) => `<button data-i="${i}">${esc(en.label)}</button>`).join('');
  menu.hidden = false;
  menu.style.left = Math.min(x, innerWidth - 190) + 'px';
  menu.style.top = Math.min(y, innerHeight - entries.length * 34 - 12) + 'px';
  menu.onclick = (e) => {
    const b = e.target.closest('button');
    if (b) { menu.hidden = true; entries[Number(b.dataset.i)].run(); }
  };
}
window.addEventListener('click', (e) => { if (!e.target.closest('#menu')) $('#menu').hidden = true; });
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { $('#menu').hidden = true; closeModal(); }
  const command = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  if (command && (e.code === 'KeyK' || key === 'k')) { e.preventDefault(); focusSearch(); }
  if (command && (e.code === 'Comma' || key === ',')) { e.preventDefault(); openModal('appearance'); }
  if (command && (e.code === 'KeyR' || key === 'r')) { e.preventDefault(); reloadActive(); }
  if (command && (e.code === 'Digit1' || key === '1')) { e.preventDefault(); closeModal(false); $('#allBtn').click(); }
  if (e.key === 'Tab' && !$('#modal').hidden) {
    const focusables = [...$('#modal').querySelectorAll('button, input, select, [tabindex="0"], summary')].filter((el) => el.getClientRects().length && !el.disabled && el.tabIndex !== -1);
    const first = focusables[0], last = focusables.at(-1);
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
});

function chatMenu(e) {
  const item = e.target.closest('.chat-item');
  if (!item) return;
  e.preventDefault();
  const c = state.chats.get(item.dataset.id);
  if (!c) return;
  const entries = [{ label: c.pinned ? 'Unpin' : 'Pin to top', run: () => (c.web ? togglePin(c.id) : guard(api.pin(c.id, !c.pinned))) }];
  if (c.unread && !c.web) entries.push({ label: 'Mark as read', run: () => guard(api.markRead(c.id)) });
  showMenu(e.clientX, e.clientY, entries);
}
$('#chatList').addEventListener('contextmenu', chatMenu);
$('#feedList').addEventListener('contextmenu', chatMenu);

$('#messages').addEventListener('contextmenu', (e) => {
  const el = e.target.closest('.msg');
  if (!el) return;
  const m = state.messages.find((x) => x.id === el.dataset.id);
  if (!m) return;
  const entries = [];
  if (m.text) entries.push({ label: 'Copy text', run: () => navigator.clipboard.writeText(m.text) });
  if (m.media) {
    entries.push({ label: 'Save as…', run: async () => { const p = await guard(api.saveAs(m.id)); if (p) toast(`Saved to ${p}`); } });
    if (m.localPath) entries.push({ label: 'Show in folder', run: () => guard(api.reveal(m.localPath)) });
  }
  if (!entries.length) return;
  e.preventDefault();
  showMenu(e.clientX, e.clientY, entries);
});

// ---------- scrolling up loads older messages from the local database ----------
$('#messages').addEventListener('scroll', async (e) => {
  if (e.target.scrollTop > 40 || state.loadingOlder || !state.messages.length) return;
  state.loadingOlder = true;
  try {
    const older = await api.messages(state.active, state.messages[0].ts);
    if (older.length) { state.messages = older.concat(state.messages); renderMessages('prepend'); }
  } finally { state.loadingOlder = false; }
});

// ---------- accounts ----------
const STATE_TEXT = { connecting: 'Connecting…', ready: 'Connected', error: 'Error' };

function accountHtml(source, title, s) {
  s = s || { state: 'connecting' };
  const ok = s.state === 'ready';
  let body = '';
  if (s.state === 'need_config') {
    body = `<p>Sign in to Telegram with the Telegram button on the left rail (phone number and code, no api_id).</p>`;
  } else if (s.state === 'need_phone') {
    body = `<form data-form="${source}:phone"><input name="v" placeholder="Phone number with country code" required><button class="btn">Send code</button></form>`;
  } else if (s.state === 'need_code') {
    body = `<p>Telegram sent a login code to your other device.</p><form data-form="${source}:code"><input name="v" placeholder="Login code" required><button class="btn">Sign in</button></form>`;
  } else if (s.state === 'need_password') {
    body = `<p>Two-step verification is on.</p><form data-form="${source}:password"><input name="v" type="password" placeholder="Password" required><button class="btn">Sign in</button></form>`;
  } else if (s.state === 'need_qr') {
    body = `<p>On your phone: WhatsApp, Linked devices, Link a device, then scan this code.</p><img class="qr" src="${esc(s.qr)}">`;
  }
  if (s.error) body += `<p class="err">${esc(s.error)}</p>`;
  const label = ok || s.state in STATE_TEXT ? STATE_TEXT[s.state] : 'Waiting for you';
  return `<div class="acct"><h3>${title}<span class="pill ${ok ? 'ok' : ''}">${label}</span></h3>${body}</div>`;
}

// The gear dialog: one row per messenger. "Open" shows that service's own web page in full (its own
// menu and settings); the second account of a service can be added or removed here too.
const SERVICE_LIST = [['tg', 'Telegram'], ['wa', 'WhatsApp'], ['ei', 'Eitaa'], ['ba', 'Bale'], ['ru', 'Rubika']];
function renderAccounts() {
  const rows = [];
  const additions = [];
  for (const k of ['tg', 'wa', 'ei', 'ba', 'ru']) {
    const second = k + '2', on = state.extra.has(second);
    const row = (key, label, extra) => {
      const status = state.webStatuses[key];
      const detail = status?.state === 'error' && status.detail?.startsWith('Could not prepare') ? 'Direct connection setup failed' : status ? ({ ready: 'Web client available', loading: 'Loading web client…', offline: 'Offline', error: 'Connection needs attention', disabled: 'Disabled' }[status.state] || 'Ready to connect') : 'Open to sign in';
      const connection = ['ei', 'ba', 'ru'].includes(k) ? 'Direct' : 'System connection';
      return `<div class="svc-row ${extra}"><span class="account-mark ${k}">${badgeHtml(k, !!extra)}</span><div class="name">${label}<small>${connection} · ${esc(detail)}</small></div>
      <button class="btn" data-open="${key}" aria-label="Open ${label}">Open</button><button class="btn ghost" data-settings="${key}" aria-label="Open ${label} settings">Settings</button>
      ${extra ? `<button class="btn ghost" data-second="${second}:0" aria-label="Remove ${label}">Remove</button>` : ''}</div>`;
    };
    rows.push(row(k, SOURCE[k], ''));
    if (on) rows.push(row(second, SOURCE[k] + ' 2', 'second'));
    else additions.push(`<div class="svc-row"><div class="name">${SOURCE[k]}</div><button class="btn ghost" data-second="${second}:1">Add account</button></div>`);
  }
  const expand = $('#accounts .additional-accounts')?.open;
  $('#accounts').innerHTML = rows.join('') + (additions.length ? `<details class="additional-accounts" ${expand ? 'open' : ''}><summary>Add another account</summary>${additions.join('')}</details>` : '');
}
$('#accounts').addEventListener('click', (e) => {
  const o = e.target.closest('[data-open]'), st = e.target.closest('[data-settings]'), sc = e.target.closest('[data-second]');
  if (o || st) {
    const key = (o || st).dataset.open || (o || st).dataset.settings;
    closeModal(false);
    setFilter(key);
    markRail(key);
    guard(o ? api.showWeb(key, true) : api.openWebSettings(key));
  } else if (sc) {
    const [key, on] = sc.dataset.second.split(':');
    if (on === '0' && state.rail === key) { setFilter(null); markRail(null); }
    guard(api.setAccount(key, on === '1'));
  }
});

async function refreshCache() {
  const c = await api.cacheInfo();
  $('#cacheInfo').textContent = `Downloaded files: ${size(c.bytes) || '0 B'} of ${size(c.max)}`;
}
let modalFocus = null;
function showSettingsPane(pane) {
  for (const button of document.querySelectorAll('[data-pane]')) {
    const selected = button.dataset.pane === pane;
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
    $(`#pane-${button.dataset.pane}`).hidden = !selected;
  }
}
async function openModal(pane = 'accounts') {
  const alreadyOpen = !$('#modal').hidden;
  if (!alreadyOpen) modalFocus = document.activeElement;
  state.modalShown = true;
  if (state.rail) await guard(api.hideWeb());
  $('#modal').hidden = false;
  showSettingsPane(pane);
  renderAccounts();
  syncPreferences();
  guard(refreshCache());
  $('#closeModal').focus();
}
function closeModal(restore = true) {
  if ($('#modal').hidden) return;
  $('#modal').hidden = true;
  state.modalShown = false;
  if (restore && state.rail) guard(api.showWeb(state.rail));
  if (restore && modalFocus?.isConnected) modalFocus.focus();
}
$('#accountsBtn').onclick = () => openModal('accounts');
$('#settingsRailBtn').onclick = () => openModal('appearance');
$('#shortcutsBtn').onclick = () => openModal('about');
$('#closeModal').onclick = () => closeModal();
$('#doneSettings').onclick = () => closeModal();
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
$('#settingsTabs').addEventListener('click', (e) => { const button = e.target.closest('[data-pane]'); if (button) showSettingsPane(button.dataset.pane); });
$('#settingsTabs').addEventListener('keydown', (e) => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
  const tabs = [...document.querySelectorAll('[data-pane]')];
  const i = tabs.indexOf(document.activeElement);
  const next = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  e.preventDefault(); showSettingsPane(tabs[next].dataset.pane); tabs[next].focus();
});
$('#clearCache').onclick = async () => {
  try {
    await api.clearCache();
    await refreshCache();
    state.messages.forEach((m) => (m.localPath = null));
    if (state.active) renderMessages('keep');
    toast('Download cache cleared.');
  } catch (e) { toast(e.message); }
};
$('#accounts').addEventListener('submit', (e) => {
  e.preventDefault();
  const [source, kind] = e.target.dataset.form.split(':');
  const f = new FormData(e.target);
  const value = kind === 'config' ? { apiId: f.get('apiId'), apiHash: f.get('apiHash') } : f.get('v');
  guard(api.provide(source, kind, value));
});

// ---------- live updates from the main process ----------
api.onChat((c) => { state.chats.set(c.id, c); renderList(); if (c.id === state.active) $('#hTitle').textContent = c.title; });
api.onChats((list) => { state.chats = new Map(list.map((c) => [c.id, c])); renderList(); });
api.onMessage((m) => {
  if (m.chatId !== state.active) return;
  const isNew = upsertMessage(m);
  renderMessages('keep');
  if (isNew && !m.out && document.hasFocus()) api.markRead(m.chatId);
});
api.onHistory(async (id) => {
  if (id !== state.active) return;
  state.messages = await api.messages(id);
  renderMessages('keep');
});
api.onStatus((s) => {
  state.statuses[s.source] = s;
  renderAccounts();
});
api.onProblem(toast);
api.onFocusChat((id) => { if (state.chats.has(id)) openChat(id); });
if (api.onWebActivated) api.onWebActivated((key) => {
  if (!/^(tg|wa|ei|ba|ru)2?$/.test(key)) return;
  closeModal(false);
  $('#menu').hidden = true;
  state.active = null;
  setFilter(key);
  markRail(key);
});
if (api.onWebStatus) api.onWebStatus((s) => {
  state.webStatuses[s.key] = s;
  updateWorkspaceStatus();
  const button = document.querySelector(`.rail-btn[data-svc="${s.key}"]`);
  if (button) { button.dataset.state = s.state; button.title = `${SOURCE[s.key.replace(/2$/, '')]}${s.key.endsWith('2') ? ' · account 2' : ''} · ${{ ready: 'Web client available', loading: 'Loading…', offline: 'Offline', error: 'Connection needs attention' }[s.state] || s.state}`; }
  if (state.modalShown) renderAccounts();
  syncEitaaRefresh();
});

function syncEitaaRefresh() {
  const button = $('#refreshEitaaBtn');
  const active = /^ei2?$/.test(state.rail || '');
  const loading = active && state.webStatuses[state.rail]?.state === 'loading';
  button.hidden = !active;
  button.disabled = !!loading;
  button.setAttribute('aria-busy', String(!!loading));
  button.querySelector('span').textContent = loading ? 'Refreshing…' : 'Refresh Eitaa';
}
$('#refreshEitaaBtn').onclick = () => {
  if (/^ei2?$/.test(state.rail || '')) guard(api.refreshEitaa(state.rail));
};

function markRail(svc) {
  document.querySelectorAll('.rail-btn[data-svc]').forEach((x) => x.classList.toggle('active', x.dataset.svc === svc));
  $('#allBtn').classList.toggle('active', !svc);
  state.rail = svc || null; // the service whose page is open, null on All
  syncEitaaRefresh();
  if (!svc) {
    // Back on All: the feed was hidden when a chat was opened from it, so it has to be shown again.
    state.active = null;
    $('#feed').hidden = false;
    $('#chatView').hidden = true;
  }
  renderList();
}
$('#allBtn').onclick = () => { setFilter(null); markRail(null); guard(api.hideWeb()); };
document.querySelectorAll('.rail-btn[data-svc]').forEach((b) => {
  b.onclick = () => {
    const off = b.classList.contains('active'); // clicking the open service again closes it
    setFilter(off ? null : b.dataset.svc);
    markRail(off ? null : b.dataset.svc);
    guard(off ? api.hideWeb() : api.showWeb(b.dataset.svc, true));
  };
});

// Optional second account per service: right click a service button to add or remove it.
state.extra = new Set();
function applyAccounts(list) {
  state.extra = new Set(list);
  for (const [id, chat] of state.chats) if (chat.source.endsWith('2') && !state.extra.has(chat.source)) state.chats.delete(id);
  document.querySelectorAll('.rail-btn[data-svc$="2"]').forEach((b) => { b.hidden = !state.extra.has(b.dataset.svc); });
  renderList();
  if (!$('#modal').hidden) renderAccounts();
}
api.onAccounts((list) => { applyAccounts(list); if (!$('#modal').hidden) renderAccounts(); });
guard(api.accounts().then(applyAccounts));
$('#rail').addEventListener('contextmenu', (e) => {
  const b = e.target.closest('.rail-btn[data-svc]');
  if (!b) return;
  e.preventDefault();
  const second = b.dataset.svc.replace(/2$/, '') + '2';
  const on = state.extra.has(second);
  showMenu(e.clientX, e.clientY, [{
    label: on ? 'Remove second account' : 'Add second account',
    run: () => {
      if (on && document.querySelector(`.rail-btn[data-svc="${second}"]`).classList.contains('active')) markRail(null);
      guard(api.setAccount(second, !on));
    },
  }]);
});

// Chat lists read from the web clients, merged into the one list.
api.onWebChats(({ key, chats }) => {
  for (const [id, c] of state.chats) if (c.source === key) state.chats.delete(id);
  const seen = new Map();
  chats.forEach((c, rank) => {
    const n = seen.get(c.title) || 0;
    seen.set(c.title, n + 1);
    const { ts, exact } = webTimestamp(c.time, rank);
    const id = `${key}:${c.title}#${n}`;
    const av = `${key}:${c.title}`;
    if (c.avatar) { avatars[av] = c.avatar; saveAvatars(); }
    state.chats.set(id, { id, source: key, web: true, n, title: c.title, lastText: c.last, lastOut: false, lastTs: ts, approx: !exact, timeText: c.time, unread: c.unread, pinned: false, archived: !!c.archived, avatar: avatars[av] || '' });
    applyPin(state.chats.get(id));
  });
  renderList();
});

// Logos of Eitaa, Bale and Rubika: the icon of each service's own page, remembered between runs.
function applyIcon(key, url) {
  document.querySelectorAll(`.rail-btn[data-svc="${key}"] .logo img, .rail-btn[data-svc="${key}2"] .logo img`).forEach((img) => {
    img.onerror = () => { img.hidden = true; };
    img.onload = () => { img.hidden = false; };
    img.src = url;
  });
}
for (const [k, u] of Object.entries(icons)) applyIcon(k, u);
function setIcon(key, url) {
  const base = key.replace(/2$/, '');
  if (!url || !['ei', 'ba', 'ru'].includes(base)) return; // Telegram and WhatsApp keep their own logos
  icons[base] = url;
  try { localStorage.setItem('icons', JSON.stringify(icons)); } catch { /* storage unavailable */ }
  applyIcon(base, url);
  renderList();
}
api.onWebIcon(({ key, url }) => setIcon(key, url));
// icons the main process already fetched before this window was ready
api.webIcons().then((all) => { for (const [k, u] of Object.entries(all || {})) setIcon(k, u); }).catch(() => {});

$('#inspectBtn').onclick = () => guard(api.inspectWeb().then((f) => { if (f) toast(`Saved: ${f}`); }));

// ---------- desktop preferences and shortcuts ----------
const systemTheme = window.matchMedia('(prefers-color-scheme: light)');
function applyPreferences(preferences) {
  state.preferences = { ...state.preferences, ...preferences };
  const theme = state.preferences.theme;
  document.documentElement.dataset.theme = theme === 'system' ? systemTheme.matches ? 'light' : 'dark' : theme || 'dark';
  document.body.classList.toggle('compact', !!state.preferences.compact);
  syncPreferences();
}
function syncPreferences() {
  for (const input of document.querySelectorAll('[data-pref]')) {
    const value = state.preferences[input.dataset.pref];
    if (input.type === 'checkbox') input.checked = !!value;
    else input.value = value || 'dark';
  }
  $('#downloadPath').textContent = state.preferences.downloadPath || 'Default download folder';
  $('#downloadPath').title = state.preferences.downloadPath || '';
}
systemTheme.addEventListener('change', () => applyPreferences(state.preferences));
if (api.onPreferences) api.onPreferences(applyPreferences);
$('#modal').addEventListener('change', async (e) => {
  const input = e.target.closest('[data-pref]');
  if (!input) return;
  input.disabled = true;
  try {
    if (!api.updatePreferences) throw new Error('Desktop preferences are unavailable.');
    applyPreferences(await api.updatePreferences({ [input.dataset.pref]: input.type === 'checkbox' ? input.checked : input.value }));
    $('#settingsStatus').textContent = 'Saved.';
  } catch (error) { syncPreferences(); toast(error.message); $('#settingsStatus').textContent = 'Could not save. Please try again.'; }
  finally { input.disabled = false; }
});
$('#chooseDownload').onclick = async () => {
  try {
    const chosen = await api.chooseDownloadDirectory();
    if (chosen) applyPreferences(await api.updatePreferences({ downloadPath: chosen }));
  } catch (error) { toast(error.message); }
};
for (const [id, kind] of [['openDownloads', 'downloads'], ['openDownloadsList', 'downloads'], ['openData', 'data'], ['openLogs', 'logs']]) $("#" + id).onclick = () => guard(api.openAppFolder(kind));
function focusSearch() { $('#search').focus(); $('#search').select(); }
function reloadActive() {
  if (!state.rail) { toast('Open a messenger to reload it.'); return; }
  const refresh = /^ei2?$/.test(state.rail) ? api.refreshEitaa(state.rail) : api.reloadWeb(state.rail);
  guard(refresh.then(() => toast(/^ei2?$/.test(state.rail || '') ? 'Refreshing Eitaa…' : 'Reloading messenger…')));
}
$('#reloadBtn').onclick = reloadActive;
if (api.onShortcut) api.onShortcut((shortcut) => {
  const action = typeof shortcut === 'string' ? shortcut : shortcut.action;
  if (action === 'search') focusSearch();
  if (action === 'settings') openModal('appearance');
  if (action === 'all') { closeModal(false); $('#allBtn').click(); }
  if (action === 'reload') reloadActive();
});
window.addEventListener('online', updateWorkspaceStatus);
window.addEventListener('offline', updateWorkspaceStatus);
window.addEventListener('unhandledrejection', (e) => { e.preventDefault(); toast(e.reason?.message || 'An unexpected error occurred. Please try again.'); });

// ---------- real download activity from the main process ----------
const downloads = new Map();
function renderDownloads() {
  const list = [...downloads.values()].reverse();
  $('#downloadsList').innerHTML = list.map((d) => {
    const progress = d.total > 0 ? Math.max(0, Math.min(100, Math.round(d.received / d.total * 100))) : null;
    const completed = d.state === 'completed';
    const status = completed ? 'Completed' : d.state === 'cancelled' ? 'Cancelled' : d.state === 'paused' ? 'Paused' : d.state === 'interrupted' || d.state === 'failed' ? 'Interrupted' : progress === null ? 'Downloading…' : `${progress}% · ${size(d.received)} of ${size(d.total)}`;
    return `<div class="download-item"><div class="download-file-icon">↓</div><div class="download-body"><strong>${esc(d.name)}</strong><small>${status}</small>${!completed && d.state !== 'cancelled' && d.state !== 'interrupted' && d.state !== 'failed' ? `<progress ${progress === null ? '' : `value="${progress}"`} max="100" aria-label="Download progress"></progress>` : ''}</div>${completed && api.revealDownload ? `<button class="btn ghost" data-reveal-download="${esc(d.id)}">Show in folder</button>` : ''}</div>`;
  }).join('') || '<div class="empty-state"><div class="empty-icon">↓</div><h3>No downloads yet</h3><p>Files you download from your messengers will appear here.</p></div>';
}
$('#downloadsBtn').onclick = () => { renderDownloads(); openModal('downloads'); };
$('#downloadsList').addEventListener('click', (e) => { const button = e.target.closest('[data-reveal-download]'); if (button && api.revealDownload) guard(api.revealDownload(button.dataset.revealDownload)); });
if (api.onDownload) api.onDownload((d) => { downloads.set(d.id, d); if (downloads.size > 100) downloads.delete(downloads.keys().next().value); renderDownloads(); });

(async function init() {
  const results = await Promise.allSettled([
    api.statuses(), api.listChats(), api.preferences ? api.preferences() : Promise.resolve(state.preferences),
    api.appInfo ? api.appInfo() : Promise.resolve(null), api.webStatuses ? api.webStatuses() : Promise.resolve([]),
    api.downloads ? api.downloads() : Promise.resolve([]),
  ]);
  const value = (i, fallback) => results[i].status === 'fulfilled' ? results[i].value : fallback;
  state.statuses = value(0, {});
  for (const chat of value(1, [])) state.chats.set(chat.id, chat);
  applyPreferences(value(2, state.preferences));
  const info = value(3, null);
  if (info) $('#versionLabel').textContent = `Version ${info.version} · Windows ${info.packaged ? 'desktop' : 'development'}`;
  const statuses = value(4, []);
  for (const status of Array.isArray(statuses) ? statuses : Object.values(statuses)) state.webStatuses[status.key] = status;
  for (const download of value(5, [])) downloads.set(download.id, download);
  state.loading = false;
  renderList();
  renderAccounts();
  renderDownloads();
  if (results[1].status === 'rejected') toast('Could not load saved conversations. Try reopening the app.');
})();
