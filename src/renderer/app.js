const api = window.messenger;
const $ = (s) => document.querySelector(s);

const state = {
  chats: new Map(), active: null, messages: [], statuses: {}, pending: [], search: '',
  downloading: new Set(), loadingOlder: false, modalShown: false,
};
const SOURCE = { tg: 'Telegram', wa: 'WhatsApp' };

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
function avatar(chat, extra = '') {
  const initials = (chat.title || '?').trim().split(/\s+/).slice(0, 2).map((w) => [...w][0]).join('').toUpperCase() || '?';
  const src = chat.source === 'tg' ? 'T' : 'W';
  return `<div class="avatar ${extra}" style="background:hsl(${hue(chat.id)} 45% 42%)">${esc(initials)}<span class="src ${chat.source}">${src}</span></div>`;
}
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

// ---------- chat list ----------
function sortedChats() {
  const q = state.search.trim().toLowerCase();
  return [...state.chats.values()]
    .filter((c) => (c.pinned || c.lastTs > 0) && (!q || c.title.toLowerCase().includes(q)))
    .sort((a, b) => (b.pinned - a.pinned) || (a.pinned ? a.pinOrder - b.pinOrder : 0) || (b.lastTs - a.lastTs));
}

let listQueued = false;
function renderList() {
  if (listQueued) return;
  listQueued = true;
  requestAnimationFrame(() => {
    listQueued = false;
    const chats = sortedChats();
    let html = '';
    let wasPinned = false;
    chats.forEach((c, i) => {
      if (wasPinned && !c.pinned) html += '<div class="divider"></div>';
      wasPinned = c.pinned;
      const last = c.lastOut ? `<span class="you">You: </span>${esc(c.lastText)}` : esc(c.lastText);
      html += `<div class="chat-item ${c.id === state.active ? 'active' : ''}" data-id="${esc(c.id)}">
        ${avatar(c)}
        <div class="c-body">
          <div class="c-row"><div class="c-title">${esc(c.title || 'Unknown')}</div><div class="c-time">${listTime(c.lastTs)}</div></div>
          <div class="c-row"><div class="c-last">${last}</div>${c.unread ? `<div class="badge">${c.unread}</div>` : c.pinned ? PIN : ''}</div>
        </div></div>`;
    });
    $('#chatList').innerHTML = html || '<div class="c-last" style="padding:20px;text-align:center">No chats yet. Connect an account with the gear button.</div>';
  });
}

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
  state.active = id;
  state.pending = [];
  renderPending();
  const chat = state.chats.get(id);
  $('#empty').hidden = true;
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
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') { $('#menu').hidden = true; $('#modal').hidden = true; } });

$('#chatList').addEventListener('contextmenu', (e) => {
  const item = e.target.closest('.chat-item');
  if (!item) return;
  e.preventDefault();
  const c = state.chats.get(item.dataset.id);
  const entries = [{ label: c.pinned ? 'Unpin' : 'Pin to top', run: () => guard(api.pin(c.id, !c.pinned)) }];
  if (c.unread) entries.push({ label: 'Mark as read', run: () => guard(api.markRead(c.id)) });
  showMenu(e.clientX, e.clientY, entries);
});

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
    body = `<p>Create an app at my.telegram.org to get these two values. They stay on this computer.</p>
      <form data-form="${source}:config"><input name="apiId" placeholder="api_id" inputmode="numeric" required><input name="apiHash" placeholder="api_hash" required><button class="btn">Continue</button></form>`;
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

function renderAccounts() {
  const focused = document.activeElement && document.activeElement.closest('#accounts');
  if (!$('#modal').hidden && focused && document.activeElement.tagName === 'INPUT') return; // do not wipe what is being typed
  $('#accounts').innerHTML = accountHtml('tg', 'Telegram', state.statuses.tg) + accountHtml('wa', 'WhatsApp', state.statuses.wa);
  const allReady = ['tg', 'wa'].every((k) => state.statuses[k] && state.statuses[k].state === 'ready');
  $('#statusDot').classList.toggle('ok', allReady);
}

async function refreshCache() {
  const c = await api.cacheInfo();
  $('#cacheInfo').textContent = `Downloaded files: ${size(c.bytes) || '0 B'} of ${size(c.max)}`;
}
function openModal() { $('#modal').hidden = false; renderAccounts(); refreshCache(); }
$('#accountsBtn').onclick = openModal;
$('#closeModal').onclick = () => ($('#modal').hidden = true);
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') $('#modal').hidden = true; });
$('#clearCache').onclick = async () => {
  await api.clearCache();
  await refreshCache();
  state.messages.forEach((m) => (m.localPath = null));
  if (state.active) renderMessages('keep');
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
  if (s.state.startsWith('need_') && $('#modal').hidden) openModal(); // login input needed
});
api.onProblem(toast);
api.onFocusChat((id) => { if (state.chats.has(id)) openChat(id); });

document.querySelectorAll('.rail-btn').forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll('.rail-btn').forEach((x) => x.classList.toggle('active', x === b));
    guard(b.dataset.svc === 'chats' ? api.hideWeb() : api.showWeb(b.dataset.svc));
  };
});

(async function init() {
  state.chats = new Map((await api.listChats()).map((c) => [c.id, c]));
  state.statuses = await api.statuses();
  renderList();
  renderAccounts();
  if (Object.values(state.statuses).some((s) => s.state.startsWith('need_'))) openModal();
})();
