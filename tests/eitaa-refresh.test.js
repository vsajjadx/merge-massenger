const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

const tick = () => new Promise(setImmediate);
function deferred() {
  let resolve;
  const promise = new Promise(ok => { resolve = ok; });
  return { promise, resolve };
}

function harness(t) {
  let nextId = 1;
  class Contents extends EventEmitter {
    constructor(ses) {
      super(); this.session = ses; this.id = nextId++; this.mainFrame = {}; this.url = '';
      this.dead = false; this.loading = false; this.loads = []; this.refreshes = 0;
    }
    getURL() { return this.url; }
    isDestroyed() { return this.dead; }
    isLoading() { return this.loading; }
    loadURL(url) { this.url = url; this.loads.push(url); return Promise.resolve(); }
    reloadIgnoringCache() { this.refreshes++; this.loading = true; }
    setWindowOpenHandler() {}
    executeJavaScript() { return Promise.resolve([]); }
    focus() {}
    close() { this.dead = true; }
  }
  const electron = {
    app: { getPath: () => '.', getName: () => 'Unified Messenger' }, net: { isOnline: () => true }, shell: {},
    session: { fromPartition() {
      return {
        proxyCalls: 0, closeCalls: 0,
        getUserAgent: () => 'Chrome', setUserAgent() {}, setPermissionRequestHandler() {}, setPermissionCheckHandler() {},
        setProxy() {
          this.proxyCalls++;
          if (this.failNext) { this.failNext = false; return Promise.reject(new Error('Proxy configuration failed')); }
          return this.gate?.promise || Promise.resolve();
        },
        closeAllConnections() { this.closeCalls++; return Promise.resolve(); },
      };
    } },
    WebContentsView: class {
      constructor(options) { this.webContents = new Contents(options.webPreferences.session); }
      setVisible() {}
      setBounds() {}
    },
  };
  const file = path.join(__dirname, '../src/main/webtabs.js');
  const mod = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    require(id) {
      return id === 'electron' ? electron : id === './webfiles' ? { webFiles: () => ({ attach() {}, detach() {} }) } : require(id);
    },
    module: mod, __dirname: path.dirname(file), URL, setTimeout, clearTimeout, setInterval, clearInterval,
  });
  const win = new EventEmitter();
  Object.assign(win, {
    getContentSize: () => [1240, 800], isDestroyed: () => false, isMinimized: () => false,
    show() {}, focus() {}, restore() {}, contentView: { addChildView() {}, removeChildView() {} },
  });
  const tabs = new mod.exports.WebTabs(win, () => {}, () => {}, () => {});
  t.after(() => tabs.dispose());
  return { tabs };
}

test('opening either Eitaa account explicitly refreshes its current conversation without cache', async t => {
  const { tabs } = harness(t);
  for (const key of ['ei', 'ei2']) {
    const view = tabs.create(key);
    await tick();
    const wc = view.webContents;
    const target = 'https://web.eitaa.com/?account=1#conversation-123';
    wc.url = target;
    const initialLoads = wc.loads.length;
    tabs.showService(key, true);
    assert.equal(tabs.currentKey, key);
    assert.equal(wc.refreshes, 1, key);
    assert.equal(wc.getURL(), target, 'conversation query and fragment survive refresh');
    assert.equal(wc.loads.length, initialLoads, 'refresh does not reset navigation to service root');
  }
});

test('ordinary showing, modal restoration and notification activation do not refresh Eitaa', async t => {
  const { tabs } = harness(t);
  const view = tabs.create('ei');
  await tick();
  view.webContents.url = 'https://web.eitaa.com/#target-message';
  tabs.show('ei', false);
  tabs.showService('ei');
  assert.equal(tabs.activateNotification(view.webContents, view.webContents.mainFrame), true);
  assert.equal(view.webContents.refreshes, 0);
  assert.equal(view.webContents.getURL(), 'https://web.eitaa.com/#target-message');
});

test('refreshing Eitaa coalesces repeated requests during loading and initial direct setup', async t => {
  const { tabs } = harness(t);
  const view = tabs.create('ei');
  const gate = deferred();
  view.webContents.session.gate = gate;
  await tick();
  tabs.showService('ei', true);
  tabs.refreshEitaa('ei');
  assert.equal(view.webContents.loads.length, 0);
  assert.equal(view.webContents.refreshes, 0);
  assert.equal(view.webContents.session.proxyCalls, 1);
  gate.resolve();
  await tick();
  assert.equal(view.webContents.loads.length, 1, 'initial page navigation remains singular and direct');
  tabs.refreshEitaa('ei');
  tabs.refreshEitaa('ei');
  assert.equal(view.webContents.refreshes, 1, 'an in-progress refresh is not restarted');
  view.webContents.loading = false;
  tabs.refreshEitaa('ei');
  assert.equal(view.webContents.refreshes, 2, 'a later refresh is available again');
});

test('failed direct setup retries through the direct-connection gate instead of refreshing an unsafe page', async t => {
  const { tabs } = harness(t);
  const view = tabs.create('ei');
  view.webContents.session.failNext = true;
  await tick();
  assert.equal(tabs.connections.get('ei').state, 'error');
  assert.equal(view.webContents.loads.length, 0);
  tabs.refreshEitaa('ei');
  assert.equal(view.webContents.refreshes, 0);
  await tick();
  assert.equal(view.webContents.session.proxyCalls, 2);
  assert.equal(tabs.connections.get('ei').state, 'ready');
  assert.equal(view.webContents.loads.length, 1);
});

test('Eitaa-specific auto-refresh never reloads another messenger or a removed account', async t => {
  const { tabs } = harness(t);
  for (const key of ['tg', 'wa', 'ba', 'ru']) {
    const view = tabs.create(key);
    await tick();
    tabs.showService(key, true);
    assert.equal(view.webContents.refreshes, 0, key);
    assert.equal(tabs.refreshEitaa(key), false, key);
    assert.equal(view.webContents.loads.length, 1, key);
  }
  assert.equal(tabs.refreshEitaa('ei2'), false);
});
