const fs = require('fs');
const path = require('path');
const { app, session, shell, WebContentsView } = require('electron');
const { webFiles } = require('./webfiles');

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
const REAL_CLICK = new Set(['ru']); // services that ignore clicks made by the page: a real mouse click is sent
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

  // Where the click starts. The page's own click handler often sits on an inner element of the row, so an
  // event fired on the row itself never reaches it: the click starts at an inner element and travels up.
  // Telegram-style rows use the text block (a click on the .peer-title opens the profile in Rubika, a
  // click on the row does nothing); the other clients use the innermost element holding the title.
  function clickTarget(row, title) {
    if (row.querySelector('.peer-title')) return row.querySelector('.user-caption') || row;
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
  const restore = (el, attr) => {
    const old = el.dataset[attr];
    if (old) el.setAttribute('style', old); else el.removeAttribute('style');
    delete el.dataset[attr];
  };
  // Undo what "reveal" did (the page's list was forced on screen for a click).
  const restoreRev = () => { for (const el of document.querySelectorAll('[data-um-rev]')) restore(el, 'umRev'); };
  const restoreAll = () => {
    restoreRev();
    for (const el of document.querySelectorAll('[data-um-hide]')) restore(el, 'umHide');
    const col = document.querySelector('[data-um-col]');
    if (col) { restore(col, 'umStyle'); delete col.dataset.umCol; }
    const grid = document.querySelector('[data-um-grid]');
    if (grid) restore(grid, 'umGrid');
  };

  if (op === 'focus') {
    const cur = document.querySelector('[data-um-col]');
    if (cur && cur.isConnected) return true;
    restoreRev();
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
  if (op === 'unfocus') { restoreAll(); return true; }

  // "reveal": the page may hide its own list while a chat is open (narrow window, its own responsive layout),
  // so a real click could land on the open chat instead of the row. The list and every wrapper around it are
  // forced into view, pinned over the page and almost transparent, just for the click.
  if (op === 'reveal') {
    restoreAll();
    const list = (rows()[0] || {}).parentElement;
    if (!list) return false;
    const comp = composer(list);
    if (!comp) return true; // no chat open: the list is where the page put it
    const chain = [];
    for (let el = list; el && el !== document.body && el !== document.documentElement && !el.contains(comp); el = el.parentElement) chain.push(el);
    for (const el of chain) {
      el.dataset.umRev = el.getAttribute('style') || '';
      el.style.setProperty('visibility', 'visible', 'important');
      el.style.setProperty('opacity', '1', 'important');
      el.style.setProperty('transform', 'none', 'important');
      el.style.setProperty('translate', 'none', 'important');
      el.style.setProperty('pointer-events', 'auto', 'important');
      if (getComputedStyle(el).display === 'none') el.style.setProperty('display', 'flex', 'important');
    }
    const col = chain[chain.length - 1];
    if (col) {
      col.style.setProperty('position', 'fixed', 'important');
      col.style.setProperty('left', '0', 'important');
      col.style.setProperty('top', '0', 'important');
      col.style.setProperty('width', Math.min(innerWidth, 420) + 'px', 'important');
      col.style.setProperty('height', innerHeight + 'px', 'important');
      col.style.setProperty('z-index', '2147483000', 'important');
      col.style.setProperty('opacity', '0.01', 'important');
    }
    return true;
  }

  if (op === 'sig') { // what the page's top area (outside the list) says now: changes when another chat opens
    const list = (rows()[0] || {}).parentElement;
    const out = [];
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n, c = 0; (n = w.nextNode()) && c < 3000; c++) {
      const t = norm(n.textContent);
      const el = n.parentElement;
      if (!t || !el || (list && list.contains(el))) continue;
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.top < 90 && r.bottom > 0) out.push(t);
    }
    return out.join('|');
  }
  if (op === 'chatopen') {
    const list = (rows()[0] || {}).parentElement;
    return !!(list && composer(list));
  }

  const items = rows().map((el) => ({ el, chat: parse(el) })).filter((x) => x.chat).slice(0, 80);
  if (op === 'list') return items.map((x) => x.chat);
  const hits = items.filter((x) => x.chat.title === arg.title);
  const target = hits[arg.n] || hits[0];
  if (!target) return false;
  const el = clickTarget(target.el, target.chat.title);
  if (op === 'opened') { // is this chat the one the page shows now?
    const row = target.el;
    if (/(^|\s)(is-)?(active|selected|current)(\s|$)/i.test(row.getAttribute('class') || '') || row.getAttribute('aria-selected') === 'true') return true;
    return [...document.querySelectorAll('.peer-title')].some((e) => !row.parentElement.contains(e) && e.getClientRects().length && norm(e.textContent) === arg.title);
  }
  if (op === 'rect') { // where a real mouse click has to land
    el.scrollIntoView({ block: 'nearest' });
    const q = el.getBoundingClientRect();
    if (!(q.width > 0 && q.height > 0)) return null;
    const x = Math.round(q.left + q.width / 2), y = Math.round(q.top + q.height / 2);
    const top = document.elementFromPoint(x, y);
    return { x, y, hit: !!(top && target.el.contains(top)) };
  }
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
  constructor(win, onChats, onAccounts, onNotice) {
    this.win = win;
    this.files = webFiles(onNotice || (() => {}));
    this.onChats = onChats;
    this.onAccounts = onAccounts;
    this.accountsFile = path.join(app.getPath('userData'), 'accounts.json');
    this.views = new Map();
    this.last = new Map();
    this.currentKey = null;
    this.focused = new Set(); // services opened from our list: their own list stays out of view
    this.busy = new Map();    // services with a chat being opened right now: the poll leaves their layout alone
    this.timer = null;
    this.hadChats = new Set(); // services whose chat list has been read at least once this session
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
    setTimeout(() => this.warmUp(), 12000);
  }

  // Fallback for pages that still do not fill their chat list while parked: every service that has not shown a
  // chat yet is brought on screen for a moment, one after the other (what opening each one by hand did), then put away.
  async warmUp() {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    for (const key of [...this.views.keys()]) {
      if (this.win.isDestroyed() || this.hadChats.has(key)) continue;
      if (this.currentKey) return; // the user opened a service: leave the layout alone
      const view = this.views.get(key);
      if (!view || view.webContents.isDestroyed()) continue;
      this.show(key, false);
      for (let i = 0; i < 8 && !this.hadChats.has(key); i++) { await sleep(500); await this.poll(); }
      if (this.currentKey === key) this.hide();
    }
  }

  create(key) {
    const ses = session.fromPartition('persist:' + key);
    // Some web clients refuse a user agent that says "Electron".
    const appToken = app.getName().replace(/\s+/g, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    ses.setUserAgent(ses.getUserAgent().replace(new RegExp(`\\s(Electron|${appToken})/\\S+`, 'gi'), ''));
    ses.setPermissionRequestHandler((_wc, permission, cb) => cb(PERMISSIONS.has(permission)));

    const view = new WebContentsView({ webPreferences: { session: ses, preload: path.join(__dirname, 'webpreload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
    view.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
    view.webContents.loadURL(SERVICES[baseOf(key)]).catch(() => {});
    // The chat list of a page that finished loading is read soon, not after the next 3 s tick.
    view.webContents.on('did-finish-load', () => { setTimeout(() => this.poll(), 1500); setTimeout(() => this.poll(), 5000); });
    this.files.attach(key, view.webContents, ses);
    this.win.contentView.addChildView(view);
    // A hidden view (setVisible(false)) makes the page report document.hidden: the web clients then do not render
    // or fill their chat list until the view has been shown once, so chats of services that were never opened were
    // missing. The view stays visible and is parked off-screen instead (see park/layout).
    view.setVisible(true);
    this.views.set(key, view);
    this.park(view);
    return view;
  }

  async poll() {
    for (const [key, view] of this.views) {
      if (view.webContents.isDestroyed() || view.webContents.isLoading()) continue;
      // The page may re-render and drop the moved column: keep it out of the way while a chat is open.
      if (this.focused.has(key) && !this.busy.get(key)) await view.webContents.executeJavaScript(`(${LIB})('focus')`).catch(() => {});
      let chats = [];
      try { chats = (await view.webContents.executeJavaScript(`(${LIB})('list')`)) || []; } catch { /* page not ready */ }
      if (chats.length) this.hadChats.add(key);
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
    this.files.detach(view.webContents.id);
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
    this.busy.set(key, (this.busy.get(key) || 0) + 1);
    try { await this.openInner(key, title, n); } finally { this.busy.set(key, this.busy.get(key) - 1); }
  }

  async openInner(key, title, n) {
    this.show(key, false);
    const view = this.views.get(key);
    const wc = view.webContents;
    const call = (op, arg) => wc.executeJavaScript(`(${LIB})(${JSON.stringify(op)}, ${JSON.stringify(arg || null)})`);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const arg = { title, n: n || 0 };
    const click = async () => {
      const pt = await call('rect', arg).catch(() => null);
      if (!pt) return false;
      wc.sendInputEvent({ type: 'mouseMove', x: pt.x, y: pt.y });
      wc.sendInputEvent({ type: 'mouseDown', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
      wc.sendInputEvent({ type: 'mouseUp', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
      return true;
    };

    if (REAL_CLICK.has(baseOf(key))) {
      // These clients only react to a real mouse click, and the row has to be under the pointer: the page's list
      // is forced into view for a moment, the row is clicked, and the click is checked (the page's header must show
      // the chat). If the chat did not change the click is repeated; the second retry first presses Escape to close
      // the open chat, which also brings the list back in the page's narrow layout.
      let opened = false;
      const sig0 = await call('sig').catch(() => '');
      for (let attempt = 0; attempt < 3 && !opened; attempt++) {
        if (attempt === 2) {
          wc.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
          wc.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
          await sleep(200);
        }
        await call('reveal').catch(() => {});
        let pt = null;
        for (let i = 0; i < 10; i++) { // the layout needs a moment after the list is forced into view
          if (i) await sleep(50);
          pt = await call('rect', arg).catch(() => null);
          if (pt && pt.hit) break;
        }
        if (!pt) throw new Error('Chat not found in the web page, open it from the service button');
        wc.sendInputEvent({ type: 'mouseMove', x: pt.x, y: pt.y });
        wc.sendInputEvent({ type: 'mouseDown', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
        wc.sendInputEvent({ type: 'mouseUp', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
        // Done as soon as the page's top area changed (another chat) or the page marks this chat as open.
        for (let i = 0; i < 14 && !opened; i++) {
          await sleep(60);
          opened = (await call('sig').catch(() => sig0)) !== sig0 || !!(await call('opened', arg).catch(() => true));
        }
      }
    } else {
      const ok = await call('open', arg);
      if (!ok) throw new Error('Chat not found in the web page, open it from the service button');
    }

    if (FOCUS.has(baseOf(key))) {
      this.focused.add(key);
      if (!REAL_CLICK.has(baseOf(key))) {
        await sleep(700);
        // Some clients ignore the click made from the page; then a real mouse click is sent to the row.
        const isOpen = await call('chatopen').catch(() => true);
        if (!isOpen) await click();
      }
      // The chat takes a moment to appear; the list can only be moved aside once its message box exists.
      for (let i = 0; i < 24; i++) {
        if (wc.isDestroyed()) return;
        if (await call('focus').catch(() => false)) break;
        await sleep(120);
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
    view.setBounds(this.onScreen());
    this.win.contentView.addChildView(view); // moves it on top
    view.webContents.focus();
  }

  hide() {
    const v = this.views.get(this.currentKey);
    if (v) this.park(v);
    this.currentKey = null;
  }

  // Same size as when shown (the page lays out its list normally), pushed to the right so that only a 1 px strip
  // stays inside the window: a view lying completely outside is not rendered, one with a visible strip is.
  park(view) {
    view.setVisible(true);
    const [w] = this.win.getContentSize();
    view.setBounds({ ...this.onScreen(), x: w - 1 });
  }

  onScreen() {
    const [w, h] = this.win.getContentSize();
    return { x: RAIL + SIDEBAR, y: 0, width: Math.max(0, w - RAIL - SIDEBAR), height: h };
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
    for (const [key, v] of this.views) {
      if (key === this.currentKey) v.setBounds(this.onScreen()); else this.park(v);
    }
  }
}

module.exports = { WebTabs };
