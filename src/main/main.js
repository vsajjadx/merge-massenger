const { app, BrowserWindow, ipcMain, dialog, shell, nativeImage, Notification, Tray, Menu, screen, nativeTheme } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { Store } = require('./db');
const { DownloadCache } = require('./cache');
const { Hub } = require('./hub');
const { WebTabs } = require('./webtabs');
const { Preferences } = require('./preferences');
const { shortcutAction } = require('./shortcuts');

// Keep every connected account alive while Windows covers or minimizes the window.
for (const name of ['disable-renderer-backgrounding', 'disable-background-timer-throttling', 'disable-backgrounding-occluded-windows']) app.commandLine.appendSwitch(name);
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
if (process.platform === 'win32') app.setAppUserModelId('com.vsajjadx.unifiedmessenger');

const CACHE_LIMIT = 2 * 1024 * 1024 * 1024;
const UI_FILE = path.join(__dirname, '..', 'renderer', 'index.html');
const UI_URL = pathToFileURL(UI_FILE).href;
// Development and QA can use a separate profile without touching an installed app.
if (process.env.UM_USER_DATA_DIR && path.isAbsolute(process.env.UM_USER_DATA_DIR)) app.setPath('userData', process.env.UM_USER_DATA_DIR);
const hasLock = app.requestSingleInstanceLock();
if (!hasLock) app.quit();
let win = null, webtabs = null, hub = null, store = null, cache = null, preferences = null;
let tray = null, quitting = false, unread = 0, windowTimer = null, logFile = null;

function logError(error, context = 'application') {
  const message = error instanceof Error ? error.stack : String(error);
  console.error(`[${context}]`, message);
  if (!logFile) return;
  try {
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > 2 * 1024 * 1024) {
      fs.copyFileSync(logFile, `${logFile}.previous`);
      fs.truncateSync(logFile);
    }
    fs.appendFileSync(logFile, `${new Date().toISOString()} [${context}] ${message}\n`);
  } catch { /* logging must not terminate the application */ }
}

function send(channel, payload) { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); }
function openExternal(url) {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) shell.openExternal(url).catch((error) => logError(error, 'external-link'));
}
function appIcon() { return nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'icon.png')); }

function showWindow() {
  if (!win || win.isDestroyed()) createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}
function saveWindow() {
  if (!win || win.isDestroyed() || !preferences || win.isMinimized()) return;
  try { preferences.saveWindow({ ...win.getNormalBounds(), maximized: win.isMaximized() }); }
  catch (error) { logError(error, 'window-state'); }
}
function restoredBounds() {
  const saved = preferences.window;
  if (!saved) return { width: 1320, height: 860 };
  const area = screen.getDisplayMatching(saved).workArea;
  const width = Math.min(saved.width, Math.max(820, area.width));
  const height = Math.min(saved.height, Math.max(520, area.height));
  return { width, height, x: Math.max(area.x, Math.min(saved.x, area.x + area.width - width)), y: Math.max(area.y, Math.min(saved.y, area.y + area.height - height)) };
}

function handleShortcut(event, input) {
  const action = shortcutAction(input);
  if (action && win && !win.isDestroyed()) {
    event.preventDefault();
    win.webContents.focus();
    send('shortcut', action);
  }
}
// Shortcuts work while focus belongs to an embedded messenger as well as the shell.
app.on('web-contents-created', (_event, contents) => contents.on('before-input-event', handleShortcut));

function createWindow() {
  win = new BrowserWindow({
    ...restoredBounds(), minWidth: 820, minHeight: 520, backgroundColor: preferences.get().theme === 'light' ? '#f4f6fa' : '#10131b',
    title: 'Unified Messenger', show: false, icon: path.join(__dirname, '..', 'assets', 'icon.ico'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.setMenuBarVisibility(false);
  webtabs = new WebTabs(win, (key, chats) => send('web:chats', { key, chats }), (list) => send('web:accounts', list), (text) => send('problem', text), (key, url) => send('web:icon', { key, url }), (status) => send('web:status', status), (download) => send('download:activity', download), (key) => send('web:activated', key));
  webtabs.setPreferences?.(preferences.get());
  webtabs.start();
  win.loadFile(UI_FILE).catch((error) => logError(error, 'load-ui'));
  win.once('ready-to-show', () => { if (preferences.window?.maximized) win.maximize(); win.show(); updateBadge(unread); });
  win.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (event, url) => { if (url !== UI_URL) { event.preventDefault(); openExternal(url); } });
  win.webContents.on('render-process-gone', (_event, details) => {
    logError(`Renderer stopped: ${details.reason} (${details.exitCode})`, 'renderer');
    if (!quitting && details.reason !== 'clean-exit') dialog.showMessageBox(win, { type: 'error', title: 'Unified Messenger', message: 'The interface stopped responding.', detail: 'Reload the interface to continue. Your connected accounts remain on this computer.', buttons: ['Reload interface', 'Quit'], defaultId: 0 }).then(({ response }) => {
      if (response === 0 && win && !win.isDestroyed()) win.webContents.reload(); else app.quit();
    }).catch((error) => logError(error, 'renderer-recovery'));
  });
  for (const event of ['resize', 'move']) win.on(event, () => { clearTimeout(windowTimer); windowTimer = setTimeout(saveWindow, 500); });
  win.on('close', (event) => {
    saveWindow();
    if (!quitting && preferences.get().closeToTray && tray) { event.preventDefault(); win.hide(); }
  });
  win.on('closed', () => { clearTimeout(windowTimer); webtabs?.dispose?.(); win = null; webtabs = null; });
}

function buildTray() {
  try { tray = new Tray(appIcon().resize({ width: 32, height: 32 })); tray.on('double-click', showWindow); updateBadge(unread); }
  catch (error) { logError(error, 'tray'); tray = null; }
}
function updateBadge(value) {
  unread = Math.max(0, Math.min(999999, Number.isFinite(Number(value)) ? Math.floor(Number(value)) : 0));
  app.setBadgeCount(unread);
  if (tray) {
    tray.setToolTip(`Unified Messenger${unread ? ` · ${unread} unread` : ''}`);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: unread ? `Open Unified Messenger (${unread} unread)` : 'Open Unified Messenger', click: showWindow },
      { label: 'Settings', click: () => { showWindow(); send('shortcut', 'settings'); } },
      { type: 'separator' }, { label: 'Quit', click: () => app.quit() },
    ]));
  }
  if (win && process.platform === 'win32') {
    if (!unread) win.setOverlayIcon(null, 'No unread messages');
    else {
      // A visible dot signals unread messages; the exact count appears in the tray tooltip.
      const size = 16, buffer = Buffer.alloc(size * size * 4);
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if ((x - 7.5) ** 2 + (y - 7.5) ** 2 < 55) {
        const i = (y * size + x) * 4; buffer[i] = 0x75; buffer[i + 1] = 0x55; buffer[i + 2] = 0xe6; buffer[i + 3] = 0xff;
      }
      win.setOverlayIcon(nativeImage.createFromBitmap(buffer, { width: size, height: size }), `${unread} unread messages`);
    }
  }
}
function applyPreferences(settings, updateLogin = false) {
  nativeTheme.themeSource = settings.theme;
  if (process.platform === 'win32' && updateLogin) app.setLoginItemSettings({ openAtLogin: settings.launchAtLogin, path: process.execPath, args: app.isPackaged ? [] : [app.getAppPath()] });
  webtabs?.setPreferences?.(settings);
  send('preferences', settings);
}
function knownFile(file) {
  if (typeof file !== 'string' || !store.isKnownFile(file) || !fs.existsSync(file)) throw new Error('File is not available');
  return file;
}
function isTrustedSender(event) {
  return !!win && !win.isDestroyed() && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame && event.senderFrame.url.split('#')[0] === UI_URL;
}

function wireIpc() {
  // The service key comes from the registered sender, never from page input.
  ipcMain.on('um:notification-click', (event) => webtabs?.activateNotification(event.sender, event.senderFrame));
  const handle = (name, fn) => ipcMain.handle(name, (event, ...args) => { if (!isTrustedSender(event)) throw new Error('This request is not allowed'); return fn(...args); });
  handle('preferences:get', () => preferences.get());
  handle('preferences:update', (patch) => { const value = preferences.update(patch); applyPreferences(value, Object.hasOwn(patch, 'launchAtLogin')); return value; });
  handle('app:info', () => ({ name: 'Unified Messenger', version: app.getVersion(), electron: process.versions.electron, node: process.versions.node, chrome: process.versions.chrome, platform: process.platform, packaged: app.isPackaged, dataPath: app.getPath('userData'), logsPath: path.dirname(logFile) }));
  handle('app:choose-download-directory', async () => {
    const result = await dialog.showOpenDialog(win, { title: 'Download folder', defaultPath: preferences.get().downloadPath, properties: ['openDirectory', 'createDirectory'] });
    return result.canceled ? null : result.filePaths[0] || null;
  });
  handle('app:open-folder', async (kind) => {
    const folder = kind === 'logs' ? path.dirname(logFile) : kind === 'downloads' ? preferences.get().downloadPath : kind === 'data' ? app.getPath('userData') : null;
    if (!folder) throw new Error('Unknown folder');
    fs.mkdirSync(folder, { recursive: true });
    const error = await shell.openPath(folder); if (error) throw new Error(error);
  });
  handle('app:unread', (count) => updateBadge(count));
  handle('app:quit', () => app.quit());
  handle('web:show', (key, refreshOnOpen = false) => webtabs?.showService(key, refreshOnOpen === true));
  handle('web:eitaa-refresh', (key) => webtabs?.refreshEitaa(key));
  handle('web:hide', () => webtabs?.hide());
  handle('web:reload', (key) => { const current = key || webtabs?.currentKey; if (current) webtabs.reload(current, 'manual', true); return !!current; });
  handle('web:statuses', () => webtabs?.getStatuses?.() || []);
  handle('downloads:list', () => webtabs?.getDownloads?.() || []);
  handle('downloads:reveal', (id) => webtabs?.revealDownload?.(id));
  handle('web:settings', (key) => webtabs.settings(key));
  handle('web:inspect', () => webtabs.inspect());
  handle('web:accounts', () => webtabs.extra());
  handle('web:account', (key, on) => (on ? webtabs.enable(key) : webtabs.disable(key)));
  handle('web:open', (key, title, n, archived) => webtabs.open(key, title, n, archived));
  handle('web:icons', () => (webtabs ? Object.fromEntries(webtabs.icons) : {}));
  handle('chats:list', () => hub.listChats());
  handle('chats:open', (id) => hub.openChat(id));
  handle('chats:messages', (id, before) => hub.messages(id, before));
  handle('chats:markRead', (id) => hub.markRead(id));
  handle('chats:pin', (id, pinned) => hub.setPinned(id, !!pinned));
  handle('status:get', () => hub.statuses);
  handle('auth:provide', (source, kind, value) => hub.provide(source, kind, value));
  handle('send:text', (id, text) => hub.sendText(id, text));
  handle('send:files', (id, files, caption) => hub.sendFiles(id, files, caption));
  handle('files:pick', async () => { const result = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'] }); return result.canceled ? [] : result.filePaths; });
  handle('media:download', (id) => hub.download(id));
  handle('media:open', async (file) => { const error = await shell.openPath(knownFile(file)); if (error) throw new Error(error); });
  handle('media:reveal', (file) => shell.showItemInFolder(knownFile(file)));
  handle('media:saveAs', async (id) => {
    const message = await hub.download(id);
    const result = await dialog.showSaveDialog(win, { defaultPath: path.join(preferences.get().downloadPath, path.basename(message.localPath)) });
    if (result.canceled || !result.filePath) return null;
    fs.copyFileSync(message.localPath, result.filePath); return result.filePath;
  });
  handle('cache:info', () => ({ bytes: store.totalBytes(), max: CACHE_LIMIT }));
  handle('cache:clear', () => { cache.clear(); return { bytes: store.totalBytes(), max: CACHE_LIMIT }; });
  ipcMain.on('drag:start', (event, file) => {
    if (!isTrustedSender(event)) return;
    try { event.sender.startDrag({ file: knownFile(file), icon: appIcon().resize({ width: 40, height: 40 }) }); }
    catch (error) { logError(error, 'drag'); }
  });
}

if (hasLock) app.whenReady().then(async () => {
  const data = app.getPath('userData');
  fs.mkdirSync(data, { recursive: true });
  app.setAppLogsPath(path.join(data, 'logs'));
  logFile = path.join(app.getPath('logs'), 'application.log');
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  preferences = new Preferences(path.join(data, 'preferences.json'), app.getPath('desktop'));
  applyPreferences(preferences.get());
  store = new Store(path.join(data, 'messages.db'));
  cache = new DownloadCache(path.join(data, 'downloads'), store, CACHE_LIMIT);
  hub = new Hub({ store, cache, adapters: [] });
  for (const event of ['chat', 'message', 'history', 'status', 'problem']) hub.on(event, (payload) => send(event, payload));
  hub.on('chats-reload', () => send('chats', hub.listChats()));
  hub.on('incoming', (chat, preview) => {
    if (!preferences.get().notifications || (win && win.isFocused()) || !Notification.isSupported()) return;
    const notification = new Notification({ title: chat.title, body: preview });
    notification.on('click', () => { showWindow(); send('focus-chat', chat.id); }); notification.show();
  });
  wireIpc(); buildTray(); createWindow(); await hub.start();
  app.on('activate', showWindow);
}).catch((error) => {
  logError(error, 'startup');
  dialog.showErrorBox('Unified Messenger could not start', `${error.message}\n\nDiagnostic details are saved in your application data logs folder.`);
  app.quit();
});
app.on('second-instance', () => { if (app.isReady() && preferences) showWindow(); });
app.on('before-quit', () => { quitting = true; saveWindow(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
process.on('unhandledRejection', (error) => { logError(error, 'unhandled-rejection'); send('problem', 'An operation failed. Try again; diagnostic details are saved in the logs folder.'); });
process.on('uncaughtException', (error) => { logError(error, 'uncaught-exception'); dialog.showErrorBox('Unified Messenger encountered an error', error.message); app.exit(1); });
