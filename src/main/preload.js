const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);
const on = (channel) => (cb) => {
  const listener = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('messenger', {
  showWeb: invoke('web:show'),
  hideWeb: invoke('web:hide'),
  inspectWeb: invoke('web:inspect'),
  openWebChat: invoke('web:open'),
  onWebChats: on('web:chats'),
  listChats: invoke('chats:list'),
  openChat: invoke('chats:open'),
  messages: invoke('chats:messages'),
  markRead: invoke('chats:markRead'),
  pin: invoke('chats:pin'),
  statuses: invoke('status:get'),
  provide: invoke('auth:provide'),
  sendText: invoke('send:text'),
  sendFiles: invoke('send:files'),
  pickFiles: invoke('files:pick'),
  download: invoke('media:download'),
  openFile: invoke('media:open'),
  reveal: invoke('media:reveal'),
  saveAs: invoke('media:saveAs'),
  cacheInfo: invoke('cache:info'),
  clearCache: invoke('cache:clear'),
  startDrag: (p) => ipcRenderer.send('drag:start', p),
  pathForFile: (file) => webUtils.getPathForFile(file),
  onChat: on('chat'),
  onChats: on('chats'),
  onMessage: on('message'),
  onHistory: on('history'),
  onStatus: on('status'),
  onProblem: on('problem'),
  onFocusChat: on('focus-chat'),
});
