const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

function deferred() {
  let resolve, reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}
const tick = () => new Promise(setImmediate);

function harness(t) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'um-routing-test-'));
  const sessions = new Map();
  const statuses = [];
  const trace = [];
  let nextId = 1;
  class Contents extends EventEmitter {
    constructor(ses) { super(); this.id = nextId++; this.session = ses; this.loads = []; this.url = ''; this.dead = false; }
    isDestroyed() { return this.dead; }
    close() { this.dead = true; }
    getURL() { return this.url; }
    isLoading() { return false; }
    setWindowOpenHandler() {}
    executeJavaScript() { return Promise.resolve([]); }
    focus() {}
    loadURL(url) { this.loads.push(url); this.url = url; trace.push(`load:${this.session.key}`); return Promise.resolve(); }
  }
  const files = { attach() {}, detach() {}, setPreferences() {} };
  const electron = {
    app: { getPath: () => folder, getName: () => 'Unified Messenger' },
    ipcMain: { handle() {}, on() {} }, net: { isOnline: () => true }, shell: { openExternal() {} },
    session: { fromPartition(key) {
      if (!sessions.has(key)) {
        const ses = new EventEmitter();
        ses.key = key;
        ses.proxyRequests = [];
        ses.closeRequests = [];
        ses.getUserAgent = () => 'Chrome/146 Electron/45';
        ses.setUserAgent = () => {};
        ses.setPermissionRequestHandler = () => {};
        ses.setPermissionCheckHandler = () => {};
        ses.setProxy = (config) => {
          const request = { config, ...deferred() };
          ses.proxyRequests.push(request);
          trace.push(`proxy:${key}`);
          return request.promise;
        };
        ses.closeAllConnections = () => {
          const request = deferred();
          ses.closeRequests.push(request);
          trace.push(`close:${key}`);
          return request.promise;
        };
        sessions.set(key, ses);
      }
      return sessions.get(key);
    } },
    WebContentsView: class {
      constructor(options) { this.webContents = new Contents(options.webPreferences.session); }
      setVisible() {}
      setBounds() {}
    },
  };
  const filename = path.join(__dirname, '..', 'src', 'main', 'webtabs.js');
  const mod = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module: mod, exports: mod.exports, __dirname: path.dirname(filename),
    Buffer, URL, setTimeout, clearTimeout, setInterval, clearInterval,
    require(id) {
      if (id === 'electron') return electron;
      if (id === './webfiles') return { webFiles: () => files };
      return require(id.startsWith('.') ? path.resolve(path.dirname(filename), id) : id);
    },
  }, { filename });
  const win = new EventEmitter();
  win.contentView = { addChildView() {}, removeChildView() {} };
  win.getContentSize = () => [1240, 800];
  win.isDestroyed = () => false;
  const tabs = new mod.exports.WebTabs(win, () => {}, () => {}, () => {}, null, status => statuses.push(status));
  t.after(() => { tabs.dispose(); fs.rmSync(folder, { recursive: true, force: true }); });
  return { tabs, sessions, statuses, trace };
}

async function finishDirect(ses, index = 0) {
  ses.proxyRequests[index].resolve();
  await tick();
  assert.ok(ses.closeRequests[index], 'Old pooled connections are closed after proxy configuration');
  ses.closeRequests[index].resolve();
  await tick();
}

test('Iranian service primary and second accounts wait for direct routing before navigation', async (t) => {
  const h = harness(t);
  const views = ['ei', 'ba', 'ru', 'ei2', 'ba2', 'ru2'].map(key => [key, h.tabs.create(key)]);
  await tick();
  for (const [key, view] of views) {
    const ses = view.webContents.session;
    assert.equal(ses.proxyRequests.length, 1, key);
    assert.equal(ses.proxyRequests[0].config.mode, 'direct', key);
    assert.equal(ses.closeRequests.length, 0, 'Close waits until configuration completes');
    assert.equal(view.webContents.loads.length, 0, 'No first navigation through system proxy');
    ses.proxyRequests[0].resolve();
  }
  await tick();
  for (const [, view] of views) {
    assert.equal(view.webContents.loads.length, 0, 'Navigation waits for old connection pool to close');
    assert.equal(view.webContents.session.closeRequests.length, 1);
    view.webContents.session.closeRequests[0].resolve();
  }
  await tick();
  for (const [key, view] of views) {
    assert.equal(view.webContents.loads.length, 1, key);
    const proxy = h.trace.indexOf(`proxy:persist:${key}`);
    const close = h.trace.indexOf(`close:persist:${key}`);
    const load = h.trace.indexOf(`load:persist:${key}`);
    assert.ok(proxy < close && close < load, 'Proxy setup and pool close precede first navigation');
  }
});

test('Telegram and WhatsApp keep their existing session proxy configuration', async (t) => {
  const h = harness(t);
  const views = ['tg', 'wa', 'tg2', 'wa2'].map(key => h.tabs.create(key));
  await tick();
  for (const view of views) {
    assert.equal(view.webContents.session.proxyRequests.length, 0, 'Existing system or command-line routing is not overridden');
    assert.equal(view.webContents.session.closeRequests.length, 0, 'Existing connections are not reset');
    assert.equal(view.webContents.loads.length, 1);
  }
});

test('Reload during pending setup cannot navigate before direct routing is ready', async (t) => {
  const h = harness(t);
  const view = h.tabs.create('ei');
  h.tabs.reload('ei');
  h.tabs.reload('ei');
  await h.tabs.pollOne('ei', view);
  assert.equal(view.webContents.loads.length, 0);
  await tick();
  assert.equal(view.webContents.session.proxyRequests.length, 1, 'Setup is shared across pending reloads');
  await finishDirect(view.webContents.session);
  assert.equal(view.webContents.loads.length, 1, 'Pending reloads coalesce into one safe navigation');
});

test('Failed direct setup never falls back to proxy; a manual reload can retry safely', async (t) => {
  const h = harness(t);
  const view = h.tabs.create('ba');
  await tick();
  view.webContents.session.proxyRequests[0].reject(new Error('Configuration rejected'));
  await tick();
  assert.equal(view.webContents.loads.length, 0);
  assert.equal(h.statuses.at(-1).state, 'error');
  await h.tabs.pollOne('ba', view);
  h.tabs.reload('ba', 'automatic', true);
  await tick();
  assert.equal(view.webContents.loads.length, 0, 'Automatic recovery cannot bypass failed direct setup');
  h.tabs.reload('ba', 'manual');
  await tick();
  const ses = view.webContents.session;
  assert.equal(ses.proxyRequests.length, 2, 'Manual reload retries configuration');
  assert.equal(ses.proxyRequests[1].config.mode, 'direct');
  ses.proxyRequests[1].resolve();
  await tick();
  assert.equal(view.webContents.loads.length, 0);
  ses.closeRequests.at(-1).resolve();
  await tick();
  assert.equal(view.webContents.loads.length, 1);
});

test('An account removed during setup cannot navigate after its configuration completes', async (t) => {
  const h = harness(t);
  const oldView = h.tabs.create('ru2');
  await tick();
  const ses = oldView.webContents.session;
  h.tabs.disable('ru2');
  assert.equal(oldView.webContents.isDestroyed(), true);
  const newView = h.tabs.create('ru2');
  await tick();
  for (const request of ses.proxyRequests) request.resolve();
  await tick();
  for (const request of ses.closeRequests) request.resolve();
  await tick();
  assert.equal(oldView.webContents.loads.length, 0, 'A stale continuation cannot load the removed view');
  assert.equal(newView.webContents.loads.length, 1, 'The recreated account can finish its own safe navigation');
});

test('Connection-pool cleanup failure also blocks navigation rather than using the old pool', async (t) => {
  const h = harness(t);
  const view = h.tabs.create('ru');
  await tick();
  const ses = view.webContents.session;
  ses.proxyRequests[0].resolve();
  await tick();
  ses.closeRequests[0].reject(new Error('Pool cleanup failed'));
  await tick();
  assert.equal(view.webContents.loads.length, 0);
  assert.equal(h.statuses.at(-1).state, 'error');
});

test('A stale account setup cannot close the recreated account connection pool', async (t) => {
  const h = harness(t);
  const oldView = h.tabs.create('ei2');
  await tick();
  const ses = oldView.webContents.session;
  h.tabs.disable('ei2');
  const newView = h.tabs.create('ei2');
  await tick();
  assert.equal(ses.proxyRequests.length, 2);
  ses.proxyRequests[1].resolve();
  await tick();
  ses.closeRequests[0].resolve();
  await tick();
  assert.equal(newView.webContents.loads.length, 1);
  ses.proxyRequests[0].resolve();
  await tick();
  assert.equal(ses.closeRequests.length, 1, 'The old setup must not interrupt the new view sockets');
  assert.equal(oldView.webContents.loads.length, 0);
});
