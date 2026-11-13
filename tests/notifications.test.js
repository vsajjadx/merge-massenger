const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

test('notification click bridge keeps native instances, static APIs and service click handlers intact', async () => {
  const sends = [];
  class NativeNotification extends EventTarget {
    static permission = 'granted';
    static requestPermission() { return Promise.resolve('granted'); }
    constructor(title, options) { super(); this.title = title; this.options = options; }
    close() { this.closed = true; }
    dispatchEvent(event) { const result = super.dispatchEvent(event); this.onclick?.(event); return result; }
  }
  const mainWorld = vm.createContext({ window: { Notification: NativeNotification } });
  const electron = {
    ipcRenderer: { send: (...args) => sends.push(args) }, webUtils: {},
    contextBridge: {
      exposeInMainWorld(key, value) { mainWorld.window[key] = value; },
      executeInMainWorld({ func }) { vm.runInContext(`(${func.toString()})()`, mainWorld); },
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/main/webpreload.js'), 'utf8'), {
    require: () => electron, document: { addEventListener() {} }, location: { hostname: 'web.telegram.org' },
  });
  const Wrapped = mainWorld.window.Notification;
  assert.equal(Wrapped.permission, 'granted');
  assert.equal(await Wrapped.requestPermission(), 'granted');
  const notification = new Wrapped('Alice', { body: 'Hello' });
  assert.ok(notification instanceof NativeNotification);
  assert.ok(notification instanceof Wrapped);
  let serviceTarget;
  notification.onclick = () => { serviceTarget = 'conversation-123'; };
  let listenerRan = false;
  notification.addEventListener('click', () => { listenerRan = true; });
  assert.equal(sends.length, 0);
  notification.dispatchEvent(new Event('click'));
  assert.deepEqual(sends, [['um:notification-click']]);
  assert.equal(serviceTarget, 'conversation-123');
  assert.equal(listenerRan, true);
  notification.close();
  assert.equal(notification.closed, true);
});

function tabsHarness() {
  let nextId = 1;
  class Contents extends EventEmitter {
    constructor() { super(); this.id = nextId++; this.mainFrame = {}; this.url = ''; this.dead = false; this.loads = []; this.focuses = 0; }
    getURL() { return this.url; }
    isDestroyed() { return this.dead; }
    setWindowOpenHandler(handler) { this.windowOpenHandler = handler; }
    loadURL(url) { this.url = url; this.loads.push(url); return Promise.resolve(); }
    executeJavaScript() { return Promise.resolve([]); }
    focus() { this.focuses++; }
    close() { this.dead = true; }
  }
  const external = [];
  const electron = {
    app: { getPath: () => '.', getName: () => 'Unified Messenger' }, net: { isOnline: () => true }, shell: { openExternal: url => external.push(url) },
    session: { fromPartition() { return { getUserAgent: () => 'Chrome', setUserAgent() {}, setPermissionRequestHandler() {}, setPermissionCheckHandler() {} }; } },
    WebContentsView: class { constructor() { this.webContents = new Contents(); } setVisible() {} setBounds(bounds) { this.bounds = bounds; } },
  };
  const mod = { exports: {} };
  const file = path.join(__dirname, '../src/main/webtabs.js');
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    require(id) { return id === 'electron' ? electron : id === './webfiles' ? { webFiles: () => ({ attach() {}, detach() {} }) } : require(id); },
    module: mod, __dirname: path.dirname(file), URL, setTimeout, clearTimeout, setInterval, clearInterval,
  });
  const activated = [];
  const win = new EventEmitter();
  Object.assign(win, { minimized: true, restores: 0, shows: 0, focuses: 0, getContentSize: () => [1240, 800], isDestroyed: () => false,
    contentView: { addChildView() {}, removeChildView() {} },
    isMinimized() { return this.minimized; }, restore() { this.minimized = false; this.restores++; }, show() { this.shows++; }, focus() { this.focuses++; },
  });
  const tabs = new mod.exports.WebTabs(win, () => {}, () => {}, () => {}, null, null, null, key => activated.push(key));
  return { tabs, win, activated, external };
}

test('notification activation restores the parent and reveals the exact primary or second account without reloading', () => {
  const { tabs, win, activated } = tabsHarness();
  const first = tabs.create('tg');
  const second = tabs.create('wa2');
  tabs.show('tg');
  assert.equal(tabs.activateNotification(second.webContents, second.webContents.mainFrame), true);
  assert.equal(win.restores, 1);
  assert.equal(win.shows, 1);
  assert.equal(win.focuses, 1);
  assert.equal(tabs.currentKey, 'wa2');
  assert.equal(second.webContents.loads.length, 1, 'existing client and its target callback stay alive');
  assert.deepEqual(activated, ['wa2']);
  assert.equal(tabs.activateNotification(first.webContents, first.webContents.mainFrame), true);
  assert.equal(tabs.currentKey, 'tg');
  assert.equal(win.restores, 1, 'already restored window is not toggled');
  tabs.dispose();
});

test('notification activation rejects unowned senders, subframes, foreign origins and destroyed views', () => {
  const { tabs, win } = tabsHarness();
  const view = tabs.create('tg');
  const wc = view.webContents;
  assert.equal(tabs.activateNotification(wc, {}), false);
  assert.equal(tabs.activateNotification({ ...wc, isDestroyed: () => false }, wc.mainFrame), false);
  wc.url = 'https://attacker.example';
  assert.equal(tabs.activateNotification(wc, wc.mainFrame), false);
  wc.url = 'https://web.telegram.org/k/'; wc.dead = true;
  assert.equal(tabs.activateNotification(wc, wc.mainFrame), false);
  assert.equal(win.shows, 0);
  tabs.dispose();
});

test('a service notification opening a conversation URL stays in its signed-in account', () => {
  const { tabs, activated, external } = tabsHarness();
  const view = tabs.create('tg2');
  const target = 'https://web.telegram.org/k/?account=2#-12345';
  const result = view.webContents.windowOpenHandler({ url: target });
  assert.equal(result.action, 'deny', 'no unowned popup window is created');
  assert.equal(tabs.currentKey, 'tg2');
  assert.equal(view.webContents.loads.at(-1), target, 'query and chat fragment survive');
  assert.deepEqual(activated, ['tg2']);
  assert.deepEqual(external, []);
  view.webContents.windowOpenHandler({ url: 'https://example.com/link' });
  assert.deepEqual(external, ['https://example.com/link']);
  view.webContents.windowOpenHandler({ url: 'file:///C:/private' });
  assert.equal(external.length, 1);
  tabs.dispose();
});
