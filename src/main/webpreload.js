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

// Files dropped on a WhatsApp chat: accepted anywhere on the page (see below).
if (/whatsapp/i.test(location.hostname)) {
  const hasFiles = (e) => e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');
  let redispatching = false; // our own events below must not be taken again

  // WhatsApp's own drop area works on the right part of the chat only (it depends on a layout that is changed
  // here). So while files are dragged over the page one overlay of this program covers all of it, and on the
  // drop the very same drop (the same files, as the browser delivered them) is passed to WhatsApp on that
  // right part: WhatsApp then handles it like a drop it received there itself.
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

  window.addEventListener('dragenter', (e) => { if (redispatching || !hasFiles(e)) return; take(e); showOverlay(); }, true);
  window.addEventListener('dragover', (e) => { if (redispatching || !hasFiles(e)) return; take(e); e.dataTransfer.dropEffect = 'copy'; showOverlay(); }, true);
  window.addEventListener('dragleave', (e) => {
    if (redispatching || !hasFiles(e)) return;
    take(e);
    if (e.clientX <= 0 || e.clientY <= 0 || e.clientX >= innerWidth - 1 || e.clientY >= innerHeight - 1) hideOverlay();
  }, true);
  window.addEventListener('dragend', hideOverlay, true);
  window.addEventListener('drop', (e) => {
    if (redispatching || !hasFiles(e)) return;
    take(e);
    hideOverlay();
    const main = document.querySelector('#main');
    if (!main) return;
    const r = main.getBoundingClientRect();
    const x = Math.round(r.left + r.width * 0.8), y = Math.round(r.top + r.height * 0.5);
    const target = document.elementFromPoint(x, y) || main;
    redispatching = true;
    try {
      for (const type of ['dragenter', 'dragover', 'drop']) {
        target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, composed: true, dataTransfer: e.dataTransfer, clientX: x, clientY: y }));
      }
    } finally { redispatching = false; }
  }, true);
}
