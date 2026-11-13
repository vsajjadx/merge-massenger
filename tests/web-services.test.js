const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

function harness() {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'um-web-test-'));
  const ipc = { handlers: {}, handle(name, fn) { this.handlers[name] = fn; }, on() {} };
  const sessions = new Map();
  const statuses = [];
  const notices = [];
  let nextId = 1;
  let revealed;
  class Contents extends EventEmitter {
    constructor(ses) { super(); this.id = nextId++; this.session = ses; this.url = ''; this.dead = false; this.loads = []; }
    isDestroyed() { return this.dead; }
    getURL() { return this.url; }
    loadURL(url) { this.url = url; this.loads.push(url); return Promise.resolve(); }
    isLoading() { return false; }
    setWindowOpenHandler() {}
    executeJavaScript() { return Promise.resolve([]); }
    close() { this.dead = true; }
    focus() {}
  }
  const electron = {
    app: { getPath: () => folder, getName: () => 'Unified Messenger' },
    ipcMain: ipc, net: { isOnline: () => true },
    shell: { openExternal() {}, showItemInFolder(file) { revealed = file; } },
    nativeImage: {},
    session: { fromPartition(key) {
      if (!sessions.has(key)) {
        const ses = new EventEmitter();
        ses.getUserAgent = () => 'Chrome/146 Electron/45';
        ses.setUserAgent = () => {};
        ses.setPermissionRequestHandler = (fn) => { ses.request = fn; };
        ses.setPermissionCheckHandler = (fn) => { ses.check = fn; };
        sessions.set(key, ses);
      }
      return sessions.get(key);
    } },
    WebContentsView: class {
      constructor(opts) { this.webContents = new Contents(opts.webPreferences.session); }
      setVisible() {}
      setBounds(bounds) { this.bounds = bounds; }
    },
  };
  function load(name, mocks = {}) {
    const filename = path.join(__dirname, '..', 'src', 'main', name + '.js');
    const mod = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
      module: mod, exports: mod.exports, Buffer, ArrayBuffer, URL, setTimeout, clearTimeout, setInterval, clearInterval,
      __dirname: path.dirname(filename),
      require(id) { return id === 'electron' ? electron : mocks[id] || require(id.startsWith('.') ? path.resolve(path.dirname(filename), id) : id); },
    }, { filename });
    return mod.exports;
  }
  const { webFiles } = load('webfiles');
  const files = webFiles((notice) => notices.push(notice));
  const { WebTabs } = load('webtabs', { './webfiles': { webFiles } });
  const win = new EventEmitter();
  win.contentView = { addChildView() {}, removeChildView() {} };
  win.isDestroyed = () => false;
  win.getContentSize = () => [1240, 800];
  const tabs = new WebTabs(win, () => {}, () => {}, (notice) => notices.push(notice), null, (s) => statuses.push(s));
  return { tabs, files, ipc, statuses, notices, folder, electron, sessions, getRevealed: () => revealed };
}

test('permissions are bound to the official service origin and notification preference', () => {
  const h = harness();
  const view = h.tabs.create('tg');
  const ses = view.webContents.session;
  assert.equal(ses.check(view.webContents, 'media', 'https://web.telegram.org'), true);
  assert.equal(ses.check(view.webContents, 'media', 'https://attacker.example'), false);
  assert.equal(ses.check(null, 'media', 'https://web.telegram.org'), false);
  assert.equal(ses.check(view.webContents, 'geolocation', 'https://web.telegram.org'), false);
  h.tabs.setPreferences({ notifications: false });
  assert.equal(ses.check(view.webContents, 'notifications', 'https://web.telegram.org'), false);
  let allowed;
  ses.request(view.webContents, 'media', (ok) => { allowed = ok; }, { requestingUrl: 'https://attacker.example' });
  assert.equal(allowed, false);
  h.tabs.dispose();
});

test('status reports failure without leaking a failed URL, manual reload bypasses cooldown', () => {
  const h = harness();
  const view = h.tabs.create('wa');
  assert.equal(h.statuses.at(-1).state, 'loading');
  view.webContents.emit('did-fail-load', {}, -106, 'secret details', 'https://example.com/private?token=secret', true);
  assert.equal(h.statuses.at(-1).state, 'offline');
  assert.equal(JSON.stringify(h.statuses).includes('secret'), false);
  view.webContents.emit('did-finish-load');
  assert.equal(h.statuses.at(-1).state, 'offline');
  assert.equal(h.tabs.reload('wa'), true);
  assert.equal(h.tabs.reload('wa'), true);
  assert.equal(h.tabs.reload('wa', 'automatic'), false);
  view.webContents.emit('did-start-loading');
  view.webContents.emit('did-finish-load');
  assert.equal(h.statuses.at(-1).state, 'ready');
  h.tabs.dispose();
  assert.equal(view.webContents.isDestroyed(), true);
  assert.equal(h.tabs.delays.size, 0);
});

class Download extends EventEmitter {
  constructor(name) { super(); this.name = name; this.received = 0; }
  getFilename() { return this.name; }
  getTotalBytes() { return 100; }
  getReceivedBytes() { return this.received; }
  isPaused() { return false; }
  setSavePath(file) { this.dest = file; }
  setSaveDialogOptions(opts) { this.dialog = opts; }
  getSavePath() { return this.dest; }
  cancel() { this.cancelled = true; }
}

test('concurrent downloads reserve different paths, sanitize Windows names and report real progress', () => {
  const h = harness();
  const first = new Download('report.pdf'), second = new Download('report.pdf');
  h.files.setPreferences({ downloadPath: h.folder });
  h.files.onDownload(first);
  h.files.onDownload(second);
  assert.equal(path.basename(first.dest), 'report.pdf');
  assert.equal(path.dirname(first.dest), h.folder);
  assert.equal(path.basename(second.dest), 'report (1).pdf');
  first.received = 60;
  first.emit('updated', {}, 'progressing');
  assert.equal(h.files.getDownloads().find((x) => x.name === 'report.pdf' && x.received === 60).received, 60);
  first.received = 100;
  first.emit('done', {}, 'completed');
  const completed = h.files.getDownloads().find((x) => x.state === 'completed');
  assert.equal(completed.path, first.dest);
  assert.throws(() => h.files.reveal('forged-path'), /no longer available/);
  const reservedName = new Download('CON.txt');
  h.files.onDownload(reservedName);
  assert.equal(path.basename(reservedName.dest), '_CON.txt');
  h.files.setPreferences({ downloadPath: h.folder, downloadPrompt: true });
  const prompted = new Download('ask.pdf');
  h.files.onDownload(prompted);
  assert.equal(prompted.dest, undefined);
  assert.equal(path.basename(prompted.dialog.defaultPath), 'ask.pdf');
  assert.equal(h.files.reserved.size, 3);
  h.tabs.dispose();
});

test('downloads without a saved destination use the Desktop itself', () => {
  const h = harness();
  const requestedPaths = [];
  h.electron.app.getPath = (name) => { requestedPaths.push(name); return h.folder; };
  const download = new Download('desktop-file.pdf');
  h.files.onDownload(download);
  assert.equal(download.dest, path.join(h.folder, 'desktop-file.pdf'));
  assert.deepEqual(requestedPaths, ['desktop']);
  h.tabs.dispose();
});

test('drag IPC rejects unowned senders and account disable clears per-account state', async () => {
  const h = harness();
  assert.equal(h.ipc.handlers['um:drag-prepare']({ sender: { id: 999 } }, { bytes: new ArrayBuffer(3), type: 'image/png' }), null);
  const view = h.tabs.create('tg2');
  h.tabs.avatarCache.set('tg2|avatar', 'data:image/png;base64,AQ==');
  h.tabs.last.set('tg2', '[]');
  h.tabs.disable('tg2');
  assert.equal(view.webContents.isDestroyed(), true);
  assert.equal(h.tabs.avatarCache.size, 0);
  assert.equal(h.tabs.last.has('tg2'), false);
  assert.equal(h.files.owners.has(view.webContents.id), false);
  assert.equal(h.statuses.at(-1).state, 'disabled');
  h.tabs.dispose();
});
