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
const SECOND = /^(tg|wa|ei|ba|ru)2$/; // optional second account of a service, own login and session
const baseOf = (key) => key.replace(/2$/, '');
const FOCUS = new Set(['ba', 'ru', 'wa']); // services whose own chat list is moved aside when a chat is opened from our list
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

// Runs inside each web client. op "list": reads the chat list; op "open": clicks the chat with the given title;
// op "focus" / "unfocus": move the page's own chat list (and icon rail) out of view / back.
const LIB = function (op, arg) {
  const FA = '۰۱۲۳۴۵۶۷۸۹', AR = '٠١٢٣٤٥٦٧٨٩';
  const norm = (s) => String(s || '').replace(/[۰-۹]/g, (d) => FA.indexOf(d)).replace(/[٠-٩]/g, (d) => AR.indexOf(d)).replace(/\s+/g, ' ').trim();
  const MON = '(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?';
  const TIME = new RegExp('^(\\d{1,2}:\\d{2}(\\s?[ap]m)?|\\d{1,4}[\\/.\\-]\\d{1,2}([\\/.\\-]\\d{1,4})?|' + MON + '\\s\\d{1,2}(,?\\s\\d{2,4})?|\\d{1,2}\\s' + MON + '(\\s\\d{2,4})?|yesterday|today|mon|tue|wed|thu|fri|sat|sun|دیروز|امروز|شنبه|یکشنبه|دوشنبه|سه‌?شنبه|چهارشنبه|پنج‌?شنبه|جمعه)$', 'i');
  const EDIT = '[contenteditable]:not([contenteditable="false"]), textarea, [role="textbox"]';

  // Telegram-style clients (Telegram, Eitaa, Rubika) have .peer-title rows; for every other client the
  // chat list is the column whose children are many similar rows.
  function rows() {
    const known = [...document.querySelectorAll('.chatlist-chat, #chatlist-container ul.chatlist > li, #folders-container ul.chatlist > li')]
      .filter((el) => el.querySelector('.peer-title') && !el.closest('rb-chat-archive, rb-chat-ads-container, #search-container, .search-group'));
    if (known.length) return known;
    let best = null;
    for (const p of document.querySelectorAll('div, ul, section')) {
      const kids = p.children;
      if (kids.length < 4 || kids.length > 400) continue;
      const r = p.getBoundingClientRect();
      if (r.width < 150 || r.width > innerWidth * 0.95 || r.height < 200) continue;
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
    if (row.querySelector('.peer-title')) {
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

  // Where the click starts. Telegram-style rows (Telegram, Eitaa, Rubika) are clicked on the row itself:
  // a click on the .peer-title inside opens the profile instead of the chat. For the other clients the
  // page's own click handler sits on an inner element of the row (Bale, WhatsApp), so the click starts at
  // the innermost element holding the title and travels up from there.
  function clickTarget(row, title) {
    if (row.querySelector('.peer-title')) return row;
    const w = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    for (let n; (n = w.nextNode());) if (norm(n.textContent) === title && n.parentElement) return n.parentElement;
    return row;
  }

  // The message box of the open chat: an input that lies beside the chat list, not above or below it
  // (the search box of the list is an input too and must not count).
  function composer(list) {
    const lr = list.getBoundingClientRect();
    return [...document.querySelectorAll(EDIT)].find((e) => {
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && (r.right <= lr.left + 1 || r.left >= lr.right - 1);
    }) || null;
  }

  // Bale, Rubika and WhatsApp show their own chat list next to the open chat, which would double our list.
  // "focus" moves that column (and the narrow icon rail beside it) out of view; it stays rendered, so the
  // list can still be read. "unfocus" puts everything back for when the service is opened with its button.
  if (op === 'focus') {
    const cur = document.querySelector('[data-um-col]');
    if (cur && cur.isConnected) return true;
    const list = (rows()[0] || {}).parentElement;
    if (!list) return false;
    const comp = composer(list);
    if (!comp) return false; // no chat is open yet, nothing to make room for
    const lw = list.getBoundingClientRect().width;
    let col = list;
    while (col.parentElement && col.parentElement !== document.body && col.parentElement !== document.documentElement) {
      const par = col.parentElement;
      if (par.contains(comp)) break;
      if (par.getBoundingClientRect().width > lw * 1.6) break;
      col = par;
    }
    if (col.contains(comp)) return false;
    const box = col.getBoundingClientRect();
    const par = col.parentElement;
    // Everything else beside the column goes too: the icon rail and the thin absolutely placed divider
    // elements some clients draw between the list and the chat (WhatsApp shows them as white lines).
    for (const sib of par.children) {
      if (sib === col || sib.contains(comp) || sib.querySelector(EDIT)) continue;
      const r = sib.getBoundingClientRect();
      const pos = getComputedStyle(sib).position;
      if (r.width <= 140 || pos === 'absolute' || pos === 'fixed') {
        sib.dataset.umHide = sib.getAttribute('style') || '';
        sib.style.setProperty('display', 'none', 'important');
      }
    }
    col.dataset.umCol = '1';
    col.dataset.umStyle = col.getAttribute('style') || '';
    col.style.cssText += `;position:fixed !important;left:-${Math.ceil(box.width) + 50}px !important;top:0 !important;width:${box.width}px !important;height:${innerHeight}px !important;`;
    if (par && getComputedStyle(par).display.includes('grid')) {
      par.dataset.umGrid = par.getAttribute('style') || '';
      par.style.setProperty('grid-template-columns', 'minmax(0, 1fr)', 'important');
    }
    return true;
  }
  if (op === 'unfocus') {
    const restore = (el, attr) => {
      const old = el.dataset[attr];
      if (old) el.setAttribute('style', old); else el.removeAttribute('style');
      delete el.dataset[attr];
    };
    for (const el of document.querySelectorAll('[data-um-hide]')) restore(el, 'umHide');
    const col = document.querySelector('[data-um-col]');
    if (col) { restore(col, 'umStyle'); delete col.dataset.umCol; }
    const grid = document.querySelector('[data-um-grid]');
    if (grid) restore(grid, 'umGrid');
    return true;
  }

  const items = rows().map((el) => ({ el, chat: parse(el) })).filter((x) => x.chat).slice(0, 80);
  if (op === 'list') return items.map((x) => x.chat);
  const hits = items.filter((x) => x.chat.title === arg.title);
  const target = hits[arg.n] || hits[0];
  if (!target) return false;
  const el = clickTarget(target.el, target.chat.title);
  const r = el.getBoundingClientRect();
  const base = { bubbles: true, cancelable: true, composed: true, view: window, button: 0, detail: 1, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
  for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
    const down = t.endsWith('down');
    const init = { ...base, buttons: down ? 1 : 0 };
    el.dispatchEvent(t.startsWith('pointer') ? new PointerEvent(t, { ...init, pointerId: 1, pointerType: 'mouse', isPrimary: true }) : new MouseEvent(t, init));
  }
  return true;
}.toString();

class WebTabs {
  constructor(win, onChats, onAccounts) {
    this.win = win;
    this.onChats = onChats;
    this.onAccounts = onAccounts;
    this.accountsFile = path.join(app.getPath('userData'), 'accounts.json');
    this.views = new Map();
    this.last = new Map();
    this.currentKey = null;
    this.focused = new Set(); // services opened from our list: their own list stays out of view
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
    let extra = [];
    try { extra = JSON.parse(fs.readFileSync(this.accountsFile, 'utf8')).filter((k) => SECOND.test(k)); } catch { /* none enabled yet */ }
    for (const key of [...Object.keys(SERVICES), ...extra]) this.create(key);
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
    view.webContents.loadURL(SERVICES[baseOf(key)]).catch(() => {});
    this.win.contentView.addChildView(view);
    view.setVisible(false);
    this.views.set(key, view);
    return view;
  }

  async poll() {
    for (const [key, view] of this.views) {
      if (view.webContents.isDestroyed() || view.webContents.isLoading()) continue;
      // The page may re-render and drop the moved column: keep it out of the way while a chat is open.
      if (this.focused.has(key)) await view.webContents.executeJavaScript(`(${LIB})('focus')`).catch(() => {});
      let chats = [];
      try { chats = (await view.webContents.executeJavaScript(`(${LIB})('list')`)) || []; } catch { /* page not ready */ }
      const json = JSON.stringify(chats);
      if (json === this.last.get(key)) continue;
      this.last.set(key, json);
      this.onChats(key, chats);
    }
  }

  extra() { return [...this.views.keys()].filter((k) => SECOND.test(k)); }

  enable(key) {
    if (!SECOND.test(key) || this.views.has(key)) return this.extra();
    this.create(key);
    this.layout();
    return this.saveExtra();
  }

  disable(key) {
    const view = this.views.get(key);
    if (!SECOND.test(key) || !view) return this.extra();
    if (this.currentKey === key) this.hide();
    this.win.contentView.removeChildView(view);
    view.webContents.close();
    this.views.delete(key);
    this.last.delete(key);
    this.focused.delete(key);
    this.onChats(key, []);
    return this.saveExtra();
  }

  saveExtra() {
    const list = this.extra();
    fs.writeFileSync(this.accountsFile, JSON.stringify(list));
    this.onAccounts(list);
    return list;
  }

  async open(key, title, n) {
    this.show(key, false);
    const view = this.views.get(key);
    const ok = await view.webContents.executeJavaScript(`(${LIB})('open', ${JSON.stringify({ title, n: n || 0 })})`);
    if (!ok) throw new Error('Chat not found in the web page, open it from the service button');
    if (FOCUS.has(baseOf(key))) {
      this.focused.add(key);
      // The chat takes a moment to appear; the list can only be moved aside once its message box exists.
      for (let i = 0; i < 16; i++) {
        await new Promise((r) => setTimeout(r, 250));
        if (view.webContents.isDestroyed()) return;
        if (await view.webContents.executeJavaScript(`(${LIB})('focus')`).catch(() => false)) break;
      }
    }
  }

  // restore: opened with its own button, so the service's full page (with its own list) is shown
  show(key, restore = true) {
    if (!this.views.has(key)) return;
    this.hide();
    this.currentKey = key;
    const view = this.views.get(key);
    if (restore && FOCUS.has(baseOf(key))) {
      this.focused.delete(key);
      view.webContents.executeJavaScript(`(${LIB})('unfocus')`).catch(() => {});
    }
    view.setVisible(true);
    this.win.contentView.addChildView(view); // moves it on top
    view.webContents.focus();
  }

  hide() {
    const v = this.views.get(this.currentKey);
    if (v) v.setVisible(false);
    this.currentKey = null;
  }

  // Opens the service with its full page and tries to open its own menu (where its settings are).
  async settings(key) {
    const view = this.views.get(key);
    if (!view) return;
    this.show(key, true);
    await new Promise((r) => setTimeout(r, 300));
    await view.webContents.executeJavaScript(`(function () {
      const click = (el) => { if (!el) return false; for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window, button: 0 })); return true; };
      return click(document.querySelector('.sidebar-header .btn-menu-toggle, .sidebar-tools-button')) || click(document.querySelector('button[aria-label="Settings"], [data-icon="settings"]'));
    })()`).catch(() => false);
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
