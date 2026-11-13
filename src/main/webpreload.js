// Runs inside every web client (Telegram, WhatsApp, Eitaa, Bale, Rubika) before the page's own scripts.
// A picture in a chat can be dragged out of the window as a file.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

// Electron dispatches a web notification click to the page, but does not reveal a
// parked WebContentsView or its parent window. Keep the real Notification and all
// service handlers intact, and add only the missing workspace activation.
contextBridge.exposeInMainWorld('unifiedMessengerNotification', {
  activate: () => ipcRenderer.send('um:notification-click'),
});
contextBridge.executeInMainWorld({ func: () => {
  const NativeNotification = window.Notification;
  if (typeof NativeNotification !== 'function') return;
  window.Notification = new Proxy(NativeNotification, {
    construct(target, args, newTarget) {
      const notification = Reflect.construct(target, args, newTarget);
      notification.addEventListener('click', () => {
        window.unifiedMessengerNotification.activate();
      });
      return notification;
    },
  });
} });

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

  // WhatsApp's drop handler is attached to a short-lived overlay and recent builds ignore synthetic
  // DragEvents (`isTrusted === false`). Keep the friendly full-page overlay, but hand the real File
  // objects to WhatsApp's own hidden file input instead of redispatching an event it will reject.
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

  window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; take(e); showOverlay(); }, true);
  window.addEventListener('dragover', (e) => { if (!hasFiles(e)) return; take(e); e.dataTransfer.dropEffect = 'copy'; showOverlay(); }, true);
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    take(e);
    if (e.clientX <= 0 || e.clientY <= 0 || e.clientX >= innerWidth - 1 || e.clientY >= innerHeight - 1) hideOverlay();
  }, true);
  window.addEventListener('dragend', hideOverlay, true);
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    take(e);
    hideOverlay();
    const files = [...e.dataTransfer.files];
    if (files.length) void attachFiles(files);
  }, true);

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const fileInputs = () => [...document.querySelectorAll('input[type="file"]')];
  const isMedia = (files) => files.length > 0 && files.every((f) => /^(image|video)\//i.test(f.type || ''));
  const inputFor = (files) => {
    const media = isMedia(files);
    const inputs = fileInputs();
    return inputs.find((input) => {
      const accept = String(input.accept || '').toLowerCase();
      if (media) return /image|video/.test(accept);
      return accept === '*' || accept === '' || accept.includes('*/*') || (input.multiple && !/image|video/.test(accept));
    }) || inputs[0] || null; // WhatsApp's always-present image input also accepts dropped documents.
  };
  const clickButton = (label) => [...document.querySelectorAll('button, [role="button"], [role="menuitem"]')]
    .find((el) => new RegExp(`^${label}$`, 'i').test(String(el.getAttribute('aria-label') || el.textContent || '').trim()))?.click();

  // Open WhatsApp's attachment menu, choose the matching native input, then assign the dropped FileList.
  // Setting input.files is accepted by the page's normal change handler and preserves its preview/caption UI.
  async function attachFiles(files) {
    let input = inputFor(files);
    if (!input) {
      if (!clickButton('Attach')) return;
      for (let i = 0; i < 20 && !input; i++) {
        await sleep(40);
        input = inputFor(files);
        if (!input) clickButton(isMedia(files) ? 'Photos & videos' : 'Document');
      }
    }
    if (!input) return false;
    const dt = new DataTransfer();
    for (const file of files) dt.items.add(file);
    try { input.files = dt.files; }
    catch { try { Object.defineProperty(input, 'files', { configurable: true, value: dt.files }); } catch { return false; } }
    if (!input.files || input.files.length !== files.length) return false;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

}
