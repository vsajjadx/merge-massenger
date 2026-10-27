const fs = require('fs');
const path = require('path');
const { app, session, shell, WebContentsView } = require('electron');

// Official web clients of the Iranian messengers, each in its own persistent session
// so the login (phone number + code, typed into the service's own page) survives restarts.
const SERVICES = {
  tg: 'https://web.telegram.org/k/',
  wa: 'https://web.whatsapp.com/',
  tg: 'https://web.telegram.org/k/',
  ei: 'https://web.eitaa.com/',
  ba: 'https://web.bale.ai/',
  ru: 'https://web.rubika.ir/',
};
const RAIL = 56; // width of the service rail on the left of the window, in px
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

class WebTabs {
  constructor(win) {
    this.win = win;
    this.views = new Map();
    this.current = null;
    this.currentKey = null;
    win.on('resize', () => this.layout());
    win.on('maximize', () => this.layout());
    win.on('unmaximize', () => this.layout());
    win.on('closed', () => { for (const v of this.views.values()) v.webContents.close(); this.views.clear(); });
  }

  create(key) {
    const ses = session.fromPartition('persist:' + key);
    // Some web clients refuse a user agent that says "Electron".
    const appToken = app.getName().replace(/\s+/g, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    ses.setUserAgent(ses.getUserAgent().replace(new RegExp(`\\s(Electron|${appToken})/\\S+`, 'gi'), ''));
    ses.setPermissionRequestHandler((_wc, permission, cb) => cb(PERMISSIONS.has(permission)));

    const view = new WebContentsView({ webPreferences: { session: ses, contextIsolation: true, nodeIntegration: false, sandbox: true } });
    view.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
    view.webContents.loadURL(SERVICES[key]).catch(() => {});
    this.views.set(key, view);
    return view;
  }

  show(key) {
    if (!SERVICES[key]) return;
    this.hide();
    const view = this.views.get(key) || this.create(key);
    this.win.contentView.addChildView(view);
    this.current = view;
    this.currentKey = key;
    this.layout();
    view.webContents.focus();
  }

  hide() {
    if (this.current) this.win.contentView.removeChildView(this.current);
    this.current = null;
    this.currentKey = null;
  }

  // Saves an anonymised outline of the open page (tags, classes, attributes; letters in texts are
  // replaced by "a") so the chat list and message elements of that web client can be located.
  async inspect() {
    if (!this.current) throw new Error('Open Eitaa, Bale or Rubika first');
    const outline = await this.current.webContents.executeJavaScript(`(${OUTLINE})()`);
    const file = path.join(app.getPath('desktop'), `${this.currentKey}-structure.txt`);
    fs.writeFileSync(file, outline);
    return file;
  }

  layout() {
    if (!this.current) return;
    const [w, h] = this.win.getContentSize();
    this.current.setBounds({ x: RAIL, y: 0, width: Math.max(0, w - RAIL), height: h });
  }
}

module.exports = { WebTabs };
