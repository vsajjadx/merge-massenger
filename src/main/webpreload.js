// Runs inside every web client (Telegram, WhatsApp, Eitaa, Bale, Rubika) before the page's own scripts.
// 1. Documents the page builds in memory (PDF, Office, archives, DWG, ...) are handed to the main
//    process, which saves them to the Desktop.
// 2. A picture in a chat can be dragged out of the window as a file.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__umDoc', (url, bytes, type, name) => {
  ipcRenderer.send('um:doc', { url, bytes, type, name });
});

// The web clients turn every downloaded file into a Blob and then a blob: URL, whether the user clicked
// it or it was fetched automatically. Watching that step catches both. Videos, audio and pictures are
// not in the list on purpose: they stay in the page.
contextBridge.executeInMainWorld({
  func: () => {
    const make = URL.createObjectURL.bind(URL);
    const MIME = /^(application\/(pdf|msword|rtf|zip|x-zip-compressed|x-rar-compressed|vnd\.rar|x-7z-compressed|gzip|x-gzip|x-tar|acad|x-acad|dwg|x-dwg|dxf|x-dxf|autocad_dwg|vnd\.ms-.+|vnd\.openxmlformats-officedocument\..+|vnd\.oasis\.opendocument\..+)|image\/(vnd\.dwg|x-dwg|vnd\.dxf)|text\/(csv|rtf))$/i;
    const EXT = /\.(pdf|docx?|xlsx?|pptx?|odt|ods|odp|rtf|txt|csv|zip|rar|7z|gz|tar|dwg|dxf)$/i;
    const MAX = 300 * 1024 * 1024;
    URL.createObjectURL = function (obj) {
      const url = make(obj);
      try {
        if (obj instanceof Blob && obj.size > 0 && obj.size < MAX) {
          const name = obj.name || '';
          if (MIME.test(obj.type || '') || EXT.test(name)) {
            obj.arrayBuffer().then((buf) => window.__umDoc(url, buf, obj.type || '', name)).catch(() => {});
          }
        }
      } catch { /* never break the page */ }
      return url;
    };
  },
});

// Drag a picture out: the file is prepared on mouse down, the drag starts once the mouse has moved.
const pictureAt = (x, y) => document.elementsFromPoint(x, y).find((el) => el.tagName === 'IMG' && el.clientWidth >= 64 && el.clientHeight >= 64 && (el.currentSrc || el.src));

async function prepare(src) {
  try {
    const blob = await (await fetch(src)).blob();
    return await ipcRenderer.invoke('um:drag-prepare', { bytes: await blob.arrayBuffer(), type: blob.type });
  } catch {
    return ipcRenderer.invoke('um:drag-prepare-url', src); // cross-origin picture: the main process fetches it
  }
}

let job = null, startX = 0, startY = 0, started = false;
document.addEventListener('mousedown', (e) => {
  job = null; started = false;
  if (e.button !== 0) return;
  const el = pictureAt(e.clientX, e.clientY);
  if (!el) return;
  startX = e.clientX; startY = e.clientY;
  job = prepare(el.currentSrc || el.src);
}, true);
document.addEventListener('mousemove', (e) => {
  if (!job || started || !(e.buttons & 1)) return;
  if (Math.hypot(e.clientX - startX, e.clientY - startY) < 8) return;
  started = true;
  job.then((file) => { if (file) ipcRenderer.send('um:drag-start', file); });
}, true);
document.addEventListener('mouseup', () => { job = null; }, true);
document.addEventListener('dragstart', (e) => { if (job) e.preventDefault(); }, true); // our file drag replaces the page's own
