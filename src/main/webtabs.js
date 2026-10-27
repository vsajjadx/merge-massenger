const { app, session, shell, WebContentsView } = require('electron');

// Official web clients of the Iranian messengers, each in its own persistent session
// so the login (phone number + code, typed into the service's own page) survives restarts.
const SERVICES = {
  ei: 'https://web.eitaa.com/',
  ba: 'https://web.bale.ai/',
  ru: 'https://web.rubika.ir/',
};
const RAIL = 56; // width of the service rail on the left of the window, in px
const PERMISSIONS = new Set(['notifications', 'media', 'fullscreen', 'clipboard-sanitized-write']);

class WebTabs {
  constructor(win) {
    this.win = win;
    this.views = new Map();
    this.current = null;
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
    this.layout();
    view.webContents.focus();
  }

  hide() {
    if (this.current) this.win.contentView.removeChildView(this.current);
    this.current = null;
  }

  layout() {
    if (!this.current) return;
    const [w, h] = this.win.getContentSize();
    this.current.setBounds({ x: RAIL, y: 0, width: Math.max(0, w - RAIL), height: h });
  }
}

module.exports = { WebTabs };
