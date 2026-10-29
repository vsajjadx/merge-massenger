// Runs inside every web client (Telegram, WhatsApp, Eitaa, Bale, Rubika) before the page's own scripts.
// A picture in a chat can be dragged out of the window as a file.
const { ipcRenderer, webUtils } = require('electron');

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

// WhatsApp does not accept files dropped on its page here. The dropped files are taken before the page sees the
// drop and attached through its own attach menu by the main process (see WebTabs.sendFiles).
if (/whatsapp/i.test(location.hostname)) {
  const hasFiles = (e) => e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');
  let passUntil = 0; // the main process asks for one drop to be left to the page (its own simulated drop)
  ipcRenderer.on('um:pass-drop', () => { passUntil = Date.now() + 4000; });
  const passing = () => Date.now() < passUntil;

  // The page's own drop areas only cover parts of the chat (the pop-up for the drop shows on one side only), and
  // where they are depends on a layout that is changed here. So as soon as files are dragged over the page, one
  // overlay of this program covers all of it: the page gets none of the drag events and a drop works anywhere.
  let overlay = null;
  const showOverlay = () => {
    if (overlay) return;
    overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;box-sizing:border-box;border:3px dashed #25d366;background:rgba(11,20,26,.72);display:grid;place-items:center;';
    const t = document.createElement('div');
    t.textContent = 'Drop files here to send them';
    t.style.cssText = 'pointer-events:none;color:#fff;font:600 18px system-ui,sans-serif;';
    overlay.appendChild(t);
    document.documentElement.appendChild(overlay);
  };
  const hideOverlay = () => { if (overlay) { overlay.remove(); overlay = null; } };
  const take = (e) => { e.preventDefault(); e.stopImmediatePropagation(); };

  window.addEventListener('dragenter', (e) => { if (!hasFiles(e) || passing()) return; take(e); showOverlay(); }, true);
  window.addEventListener('dragover', (e) => { if (!hasFiles(e) || passing()) return; take(e); e.dataTransfer.dropEffect = 'copy'; showOverlay(); }, true);
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e) || passing()) return;
    take(e);
    if (e.clientX <= 0 || e.clientY <= 0 || e.clientX >= innerWidth - 1 || e.clientY >= innerHeight - 1) hideOverlay();
  }, true);
  window.addEventListener('dragend', hideOverlay, true);
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e) || passing()) return;
    hideOverlay();
    const list = [...e.dataTransfer.files];
    for (const it of e.dataTransfer.items || []) { const f = it.kind === 'file' ? it.getAsFile() : null; if (f && !list.includes(f)) list.push(f); }
    const paths = [...new Set(list.map((f) => { try { return webUtils.getPathForFile(f); } catch { return ''; } }).filter(Boolean))];
    take(e);
    if (paths.length) ipcRenderer.send('um:wa-drop', paths);
  }, true);
}
