const { app, BrowserWindow, ipcMain, dialog, shell, nativeImage, Notification } = require('electron');
const fs = require('fs');
const path = require('path');
const { Store } = require('./db');
const { DownloadCache } = require('./cache');
const { Hub } = require('./hub');
const secrets = require('./secrets');
const { TelegramAdapter } = require('./adapters/telegram');
const { WhatsAppAdapter } = require('./adapters/whatsapp');
const { WebTabs } = require('./webtabs');

const CACHE_LIMIT = 2 * 1024 * 1024 * 1024; // 2 GB, least recently used files are removed first

if (!app.requestSingleInstanceLock()) app.quit();

let win = null;
let webtabs = null;
let hub = null;
let store = null;
let cache = null;

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1240, height: 800, minWidth: 820, minHeight: 520, backgroundColor: '#0e1621', title: 'Unified Messenger',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.setMenuBarVisibility(false);
  webtabs = new WebTabs(win);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  // Links in messages open in the real browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file:')) { e.preventDefault(); if (/^https?:/i.test(url)) shell.openExternal(url); } });
  win.on('closed', () => { win = null; webtabs = null; });
}

// A solid square is enough as the icon that follows the cursor while dragging a file out.
function dragIcon() {
  const size = 40;
  const buf = Buffer.alloc(size * size * 4);
  for (let i = 0; i < buf.length; i += 4) { buf[i] = 0xf7; buf[i + 1] = 0xb5; buf[i + 2] = 0x5e; buf[i + 3] = 0xff; }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

function knownFile(p) {
  if (typeof p !== 'string' || !store.isKnownFile(p) || !fs.existsSync(p)) throw new Error('File is not available');
  return p;
}

function wireIpc() {
  const handle = (name, fn) => ipcMain.handle(name, (_e, ...args) => fn(...args));

  handle('web:show', (key) => webtabs && webtabs.show(key));
  handle('web:hide', () => webtabs && webtabs.hide());

  handle('chats:list', () => hub.listChats());
  handle('chats:open', (id) => hub.openChat(id));
  handle('chats:messages', (id, before) => hub.messages(id, before));
  handle('chats:markRead', (id) => hub.markRead(id));
  handle('chats:pin', (id, pinned) => hub.setPinned(id, !!pinned));
  handle('status:get', () => hub.statuses);
  handle('auth:provide', (source, kind, value) => hub.provide(source, kind, value));

  handle('send:text', (id, text) => hub.sendText(id, text));
  handle('send:files', (id, files, caption) => hub.sendFiles(id, files, caption));
  handle('files:pick', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'] });
    return r.canceled ? [] : r.filePaths;
  });

  handle('media:download', (msgId) => hub.download(msgId));
  handle('media:open', async (p) => { const err = await shell.openPath(knownFile(p)); if (err) throw new Error(err); });
  handle('media:reveal', (p) => shell.showItemInFolder(knownFile(p)));
  handle('media:saveAs', async (msgId) => {
    const msg = await hub.download(msgId);
    const r = await dialog.showSaveDialog(win, { defaultPath: path.basename(msg.localPath) });
    if (r.canceled || !r.filePath) return null;
    fs.copyFileSync(msg.localPath, r.filePath);
    return r.filePath;
  });

  handle('cache:info', () => ({ bytes: store.totalBytes(), max: CACHE_LIMIT }));
  handle('cache:clear', () => { cache.clear(); return { bytes: store.totalBytes(), max: CACHE_LIMIT }; });

  // Drag a downloaded file out of the window (into Explorer, another app, ...).
  ipcMain.on('drag:start', (e, p) => {
    try { e.sender.startDrag({ file: knownFile(p), icon: dragIcon() }); } catch { /* not downloaded yet */ }
  });
}

app.whenReady().then(async () => {
  const data = app.getPath('userData');
  store = new Store(path.join(data, 'messages.db'));
  cache = new DownloadCache(path.join(data, 'downloads'), store, CACHE_LIMIT);
  hub = new Hub({
    store, cache,
    adapters: [
      new TelegramAdapter({ secrets }),
      new WhatsAppAdapter({ authDir: path.join(data, 'wa-auth') }),
    ],
  });

  hub.on('chat', (c) => send('chat', c));
  hub.on('message', (m) => send('message', m));
  hub.on('history', (id) => send('history', id));
  hub.on('status', (s) => send('status', s));
  hub.on('problem', (text) => send('problem', text));
  hub.on('chats-reload', () => send('chats', hub.listChats()));
  hub.on('incoming', (chat, preview) => {
    if (win && win.isFocused() || !Notification.isSupported()) return;
    const n = new Notification({ title: chat.title, body: preview });
    n.on('click', () => { if (win) { win.show(); win.focus(); send('focus-chat', chat.id); } });
    n.show();
  });

  wireIpc();
  createWindow();
  hub.start();

  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
