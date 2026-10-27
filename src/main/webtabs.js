const fs = require('fs');
const path = require('path');
const { app, session, shell, WebContentsView } = require('electron');

// Official web clients, each in its own persistent session so the login survives restarts.
// All of them stay loaded in the background: their chat lists are read every few seconds and
// merged into the one list in the sidebar; opening a chat there shows that service's page.
const SERVICES = {
  tg: 'https://web.telegram.org/k/',
  wa: 'https://web.whatsapp.com/',
  ei: 'https://web.eitaa.com/',
  ba: 'https://web.bale.ai/',
  ru: 'https://web.rubika.ir/',
};
const RAIL = 56;      // service rail, px
const SIDEBAR = 340;  // unified chat list, px (same as #sidebar in styles.css)
const POLL_MS = 3000;
const PERMISSIONS = new Set(['notifications', 'media', 'fullscreen', 'clipboard-sanitized-write']);

const OUTLINE = function () {
  const mask = (t) => String(t || '').replace(/\p{L}/gu, 'a');
  const out = [`url: ${location.origin}${location.pathname}`, `viewport: ${innerWidth}x${innerHeight}`];
  let count = 0;
  const walk = (el, depth) => {
    if (count++ > 6000 || depth > 30) return;
    const tag = el.tagName.toLowerCase();
    let line = '  '.repeat(depth) + tag;
    if (el.id) line += '#' + el.id;
    const cls = (el.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean);
    if (cls.length) line += '.' + cls.join('.');
    for (const a of el.attributes) {
      if (a.name === 'class' || a.name === 'id' || a.name === 'style') continue;
      if (/^(role|type|contenteditable|dir|tabindex|placeholder|aria-.*|data-.*)$/.test(a.name)) line += ` [${a.name}=${mask(a.value).slice(0, 40)}]`;
    }
    const text = Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(' ').slice(0, 40);
    if (text) line += ` "${mask(text)}"`;
    out.push(line);
    if (tag === 'svg') return;
    const seen = new Map();
    for (const k of el.children) {
      if (/^(script|style|noscript|path)$/i.test(k.tagName)) continue;
      const sig = k.tagName.toLowerCase() + '.' + (k.getAttribute('class') || '');
      const n = (seen.get(sig) || 0) + 1;
      seen.set(sig, n);
      if (n <= 3) walk(k, depth + 1);
    }
    for (const [sig, n] of seen) if (n > 3) out.push('  '.repeat(depth + 1) + `... +${n - 3} similar: ${sig}`);
  };
  walk(document.body, 0);
  return out.join('\n');
}.toString();

// Runs inside each web client. op "list": reads the chat list; op "open": clicks the chat with the given title.
const LIB = function (op, arg) {
  const FA = '۰۱۲۳۴۵۶۷۸۹', AR = '٠١٢٣٤٥٦٧٨٩';
  const norm = (s) => String(s || '').replace(/[۰-۹]/g, (d) => FA.indexOf(d)).replace(/[٠-٩]/g, (d) => AR.indexOf(d)).replace(/\s+/g, ' ').trim();
  const TIME = /^(\d{1,2}:\d{2}(\s?[ap]m)?|\d{1,4}[\/.\-]\d{1,2}([\/.\-]\d{1,4})?|yesterday|today|mon|tue|wed|thu|fri|sat|sun|دیروز|امروز|شنبه|یکشنبه|دوشنبه|سه‌?شنبه|چهارشنبه|پنج‌?شنبه|جمعه)$/i;

  // Telegram-style clients have a known row class; for every other client the chat list is the
  // narrow column whose children are many similar rows.
  function rows() {
    const known = document.querySelectorAll('.chatlist-chat');
    if (known.length) return [...known];
    let best = null;
    for (const p of document.querySelectorAll('div, ul, section')) {
      const kids = p.children;
      if (kids.length < 4 || kids.length > 400) continue;
      const r = p.getBoundingClientRect();
      if (r.width < 150 || r.width > innerWidth * 0.6 || r.height < 200) continue;
      const tag = kids[0].tagName;
      let same = 0, text = 0;
      for (const k of kids) { if (k.tagName === tag) same++; if (norm(k.innerText)) text++; }
      if (same < kids.length * 0.8 || text < kids.length * 0.8) continue;
      const kh = kids[0].getBoundingClientRect().height;
      if (kh < 40 || kh > 150) continue;
      if (!best || kids.length > best.children.length) best = p;
    }
    return best ? [...best.children] : [];
  }

  function parse(row) {
    if (row.classList.contains('chatlist-chat')) {
      const q = (s) => norm((row.querySelector(s) || {}).textContent);
      const title = q('.peer-title');
      return title ? { title, last: q('.user-last-message'), time: q('.message-time'), unread: parseInt(q('.dialog-subtitle-badge')) || 0 } : null;
    }
    const texts = [];
    const w = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    for (let n; (n = w.nextNode());) { const t = norm(n.textContent); if (t) texts.push(t); }
    const ti = texts.findIndex((t) => !TIME.test(t) && !/^\d{1,3}\+?$/.test(t));
    if (ti < 0) return null;
    const title = texts.splice(ti, 1)[0];
    let time = '', unread = 0;
    const i = texts.findIndex((t) => TIME.test(t));
    if (i >= 0) time = texts.splice(i, 1)[0];
    if (texts.length > 1 && /^\d{1,3}\+?$/.test(texts[texts.length - 1])) unread = parseInt(texts.pop());
    return { title, last: texts.sort((a, b) => b.length - a.length)[0] || '', time, unread };
  }

  const items = rows().map((el) => ({ el, chat: parse(el) })).filter((x) => x.chat).slice(0, 80);
  if (op === 'list') return items.map((x) => x.chat);
  const hits = items.filter((x) => x.chat.title === arg.title);
  const target = hits[arg.n] || hits[0];
  if (!target) return false;
  for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
    target.el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window, button: 0 }));
  }
  return true;
}.toString();

class WebTabs {
  constructor(win, onChats) {
    this.win = win;
    this.onChats = onChats;
    this.views = new Map();
    this.last = new Map();
    this.currentKey = null;
    this.timer = null;
    win.on('resize', () => this.layout());
    win.on('maximize', () => this.layout());
    win.on('unmaximize', () => this.layout());
    win.on('closed', () => {
      clearInterval(this.timer);
      for (const v of this.views.values()) v.webContents.close();
      this.views.clear();
    });
  }

  start() {
    for (const key of Object.keys(SERVICES)) this.create(key);
    this.layout();
    this.timer = setInterval(() => this.poll(), POLL_MS);
  }

  create(key) {
    const ses = session.fromPartition('persist:' + key);
    // Some web clients refuse a user agent that says "Electron".
    const appToken = app.getName().replace(/\s+/g, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    ses.setUserAgent(ses.getUserAgent().replace(new RegExp(`\\s(Electron|${appToken})/\\S+`, 'gi'), ''));
    ses.setPermissionRequestHandler((_wc, permission, cb) => cb(PERMISSIONS.has(permission)));

    const view = new WebContentsView({ webPreferences: { session: ses, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
    view.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
    view.webContents.loadURL(SERVICES[key]).catch(() => {});
    this.win.contentView.addChildView(view);
    view.setVisible(false);
    this.views.set(key, view);
    return view;
  }

  async poll() {
    for (const [key, view] of this.views) {
      if (view.webContents.isDestroyed() || view.webContents.isLoading()) continue;
      let chats = [];
      try { chats = (await view.webContents.executeJavaScript(`(${LIB})('list')`)) || []; } catch { /* page not ready */ }
      const json = JSON.stringify(chats);
      if (json === this.last.get(key)) continue;
      this.last.set(key, json);
      this.onChats(key, chats);
    }
  }

  async open(key, title, n) {
    this.show(key);
    const view = this.views.get(key);
    const ok = await view.webContents.executeJavaScript(`(${LIB})('open', ${JSON.stringify({ title, n: n || 0 })})`);
    if (!ok) throw new Error('Chat not found in the web page, open it from the service button');
  }

  show(key) {
    if (!SERVICES[key]) return;
    this.hide();
    this.currentKey = key;
    const view = this.views.get(key);
    view.setVisible(true);
    this.win.contentView.addChildView(view); // moves it on top
    view.webContents.focus();
  }

  hide() {
    const v = this.views.get(this.currentKey);
    if (v) v.setVisible(false);
    this.currentKey = null;
  }

  // Saves an anonymised outline of the open page (tags, classes, attributes; letters in texts are
  // replaced by "a") so the chat list and message elements of that web client can be located.
  async inspect() {
    const view = this.views.get(this.currentKey);
    if (!view) throw new Error('Open a service from the left buttons first');
    const outline = await view.webContents.executeJavaScript(`(${OUTLINE})()`);
    const file = path.join(app.getPath('desktop'), `${this.currentKey}-structure.txt`);
    fs.writeFileSync(file, outline);
    return file;
  }

  layout() {
    const [w, h] = this.win.getContentSize();
    const bounds = { x: RAIL + SIDEBAR, y: 0, width: Math.max(0, w - RAIL - SIDEBAR), height: h };
    for (const v of this.views.values()) v.setBounds(bounds);
  }
}

module.exports = { WebTabs };
