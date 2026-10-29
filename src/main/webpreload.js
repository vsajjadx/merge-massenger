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
  // The page may not accept the drag over some parts of the chat; without this the drop would never happen.
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } }, true);
  let passUntil = 0; // the main process asks for one drop to be left to the page (its own simulated drop)
  ipcRenderer.on('um:pass-drop', () => { passUntil = Date.now() + 4000; });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e) || Date.now() < passUntil) return;
    const list = [...e.dataTransfer.files];
    for (const it of e.dataTransfer.items || []) { const f = it.kind === 'file' ? it.getAsFile() : null; if (f && !list.includes(f)) list.push(f); }
    const paths = [...new Set(list.map((f) => { try { return webUtils.getPathForFile(f); } catch { return ''; } }).filter(Boolean))];
    if (!paths.length) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    ipcRenderer.send('um:wa-drop', paths);
    // the page never saw the drop: tell it that the drag is over so that its drop overlay goes away
    const target = e.target;
    for (let i = 0; i < 3; i++) setTimeout(() => { target.dispatchEvent(new DragEvent('dragleave', { bubbles: true, cancelable: true })); document.dispatchEvent(new DragEvent('dragend', { bubbles: true })); }, 30 * (i + 1));
  }, true);
}
