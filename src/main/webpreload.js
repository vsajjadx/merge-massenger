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
  let passUntil = 0;
  // The main process may carry out one direct drag on the page. Let that trusted browser path reach WhatsApp
  // instead of catching it again in this bridge.
  ipcRenderer.on('um:pass-drop', () => {
    // Tell the main process that the bridge is ready before it dispatches the synthetic
    // browser drag.  Without this handshake the first drag could arrive while this
    // preload was still catching normal user drops, so the first attempt was swallowed.
    passUntil = Date.now() + 8000;
    ipcRenderer.send('um:pass-drop-ready');
  });
  const passing = () => Date.now() < passUntil;

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

  window.addEventListener('dragenter', (e) => { if (passing() || !hasFiles(e)) return; take(e); showOverlay(); }, true);
  window.addEventListener('dragover', (e) => { if (passing() || !hasFiles(e)) return; take(e); e.dataTransfer.dropEffect = 'copy'; showOverlay(); }, true);
  window.addEventListener('dragleave', (e) => {
    if (passing() || !hasFiles(e)) return;
    take(e);
    if (e.clientX <= 0 || e.clientY <= 0 || e.clientX >= innerWidth - 1 || e.clientY >= innerHeight - 1) hideOverlay();
  }, true);
  window.addEventListener('dragend', hideOverlay, true);
  window.addEventListener('drop', (e) => {
    if (passing() || !hasFiles(e)) return;
    take(e);
    hideOverlay();
    const files = [...e.dataTransfer.files];
    if (files.length) void attachFiles(files);
  }, true);

  const fileInputs = () => [...document.querySelectorAll('input[type="file"]')];
  const inferredMime = (name) => {
    const ext = String(name || '').toLowerCase().match(/\.[a-z0-9]{1,8}$/)?.[0] || '';
    return ({
      '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp',
      '.bmp': 'image/bmp', '.heic': 'image/heic', '.heif': 'image/heif', '.mp4': 'video/mp4', '.mov': 'video/quicktime',
      '.mkv': 'video/x-matroska', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
      '.pdf': 'application/pdf', '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      '.zip': 'application/zip', '.rar': 'application/vnd.rar', '.7z': 'application/x-7z-compressed', '.txt': 'text/plain',
    })[ext] || '';
  };

  const pathsFor = (files) => [...new Set(files.map((file) => {
    try { return webUtils.getPathForFile(file); } catch { return ''; }
  }).filter(Boolean))];
  const fileMime = (file) => String(file?.type || inferredMime(file?.name)).toLowerCase();
  const isMedia = (files) => files.length > 0 && files.every((f) => /^(image|video)\//i.test(fileMime(f)));
  const accepts = (input, file) => {
    const raw = String(input.accept || '').trim().toLowerCase();
    if (!raw) return true; // an empty accept is the browser's "all files" input
    const type = fileMime(file);
    const name = String(file?.name || '').toLowerCase();
    return raw.split(',').map((token) => token.trim()).filter(Boolean).some((token) => {
      if (token === '*' || token === '*/*') return true;
      if (token.endsWith('/*')) return type.startsWith(token.slice(0, -1));
      if (token.startsWith('.')) return name.endsWith(token);
      return type === token;
    });
  };
  const inputFor = (files) => {
    const media = isMedia(files);
    const candidates = fileInputs().filter((input) =>
      (input.multiple || files.length === 1) && files.every((file) => accepts(input, file))
    );
    // Prefer WhatsApp's media input for pictures/videos and its document/all-files input for everything else.
    return candidates.sort((a, b) => {
      const score = (input) => {
        const accept = String(input.accept || '').toLowerCase();
        const mediaInput = /image|video/.test(accept);
        return media === mediaInput ? 3 : 0;
      };
      return score(b) - score(a);
    })[0] || null;
  };
  const clickButton = (label) => {
    const wanted = String(label).trim().toLowerCase();
    const el = [...document.querySelectorAll('button, [role="button"], [role="menuitem"]')]
      .find((item) => String(item.getAttribute('aria-label') || item.textContent || '').trim().toLowerCase() === wanted);
    if (!el) return false;
    try { el.click(); return true; } catch { return false; }
  };
  const assignFiles = (input, files) => {
    if (!input) return false;
    const dt = new DataTransfer();
    for (const file of files) dt.items.add(file);
    try { input.files = dt.files; }
    catch { try { Object.defineProperty(input, 'files', { configurable: true, value: dt.files }); } catch { return false; } }
    if (!input.files || input.files.length !== files.length) return false;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  };
  // WhatsApp only creates its document input after the attachment command is selected. Trigger that command
  // in the page (without sending a native click through the window) and keep the short-lived menu invisible.
  // The normal input/change handler then opens the native preview on the very first user drop.
  async function inputFromMenu(files) {
    if (typeof document.createElement !== 'function') return null;
    const shield = document.createElement('style');
    shield.textContent = '[role="menu"], [role="menuitem"], [aria-label="Photos & videos"], [aria-label="Document"] { visibility: hidden !important; }';
    (document.head || document.documentElement).appendChild(shield);
    // Selecting WhatsApp's Document command normally calls input.click(), which opens a native Windows
    // file picker. The dropped File objects are already in hand, so suppress only that picker activation;
    // the subsequent change event is still delivered to WhatsApp's own input below.
    const stopPicker = (event) => {
      const target = event.target;
      if (target?.tagName === 'INPUT' && String(target.type).toLowerCase() === 'file') event.preventDefault();
    };
    for (const type of ['pointerdown', 'mousedown', 'click']) document.addEventListener(type, stopPicker, true);
    try {
      if (!clickButton('Attach')) return null;
      await new Promise((resolve) => setTimeout(resolve, 30));
      clickButton(isMedia(files) ? 'Photos & videos' : 'Document');
      let input = inputFor(files);
      for (let i = 0; i < 36 && !input; i++) {
        await new Promise((resolve) => setTimeout(resolve, 30));
        input = inputFor(files);
      }
      return input;
    } finally {
      for (const type of ['pointerdown', 'mousedown', 'click']) document.removeEventListener(type, stopPicker, true);
      shield.remove();
    }
  }

  // Assign the dropped FileList to WhatsApp's own input. This preserves its preview/caption UI and avoids
  // redispatching an untrusted DOM DragEvent.
  async function attachFiles(files) {
    let input = inputFor(files);
    if (!input) {
      input = await inputFromMenu(files);
    }
    if (assignFiles(input, files)) return true;

    // Last-resort path for a WhatsApp build that does not expose its attachment menu/input to the page.
    // This still never opens the + menu visibly; the main process performs a browser-level drop instead.
    const paths = pathsFor(files);
    if (paths.length) ipcRenderer.send('um:wa-drop-direct', paths);
    return paths.length > 0;
  }

}
