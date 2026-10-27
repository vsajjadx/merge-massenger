const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, ipcMain, nativeImage } = require('electron');
const { safeFileName } = require('./shared');

const EXT = {
  'application/pdf': '.pdf', 'application/msword': '.doc', 'application/rtf': '.rtf', 'text/rtf': '.rtf', 'text/csv': '.csv',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'application/vnd.ms-excel': '.xls', 'application/vnd.ms-powerpoint': '.ppt',
  'application/vnd.oasis.opendocument.text': '.odt', 'application/vnd.oasis.opendocument.spreadsheet': '.ods',
  'application/zip': '.zip', 'application/x-zip-compressed': '.zip', 'application/x-rar-compressed': '.rar', 'application/vnd.rar': '.rar',
  'application/x-7z-compressed': '.7z', 'application/gzip': '.gz', 'application/x-gzip': '.gz', 'application/x-tar': '.tar',
  'application/acad': '.dwg', 'application/x-acad': '.dwg', 'application/dwg': '.dwg', 'application/x-dwg': '.dwg', 'image/vnd.dwg': '.dwg', 'image/x-dwg': '.dwg',
  'application/dxf': '.dxf', 'application/x-dxf': '.dxf', 'image/vnd.dxf': '.dxf',
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp',
};

const stamp = () => new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);

function uniquePath(dir, name) {
  const ext = path.extname(name), base = path.basename(name, ext);
  let p = path.join(dir, name), i = 1;
  while (fs.existsSync(p)) p = path.join(dir, `${base} (${i++})${ext}`);
  return p;
}

// Files that come out of the web clients: downloads the user starts (no dialog, straight to the Desktop)
// and pictures dragged out of a chat. Nothing is saved without the user asking for it.
class WebFiles {
  constructor(notify) {
    this.notify = notify;
    this.owners = new Map();    // webContents id -> { key, ses }
    this.dragDir = path.join(os.tmpdir(), 'unified-messenger-drag');

    ipcMain.handle('um:drag-prepare', (_e, d) => this.writeDrag(Buffer.from(d.bytes), d.type));
    ipcMain.handle('um:drag-prepare-url', async (e, url) => {
      const o = this.owners.get(e.sender.id);
      if (!o || !/^https?:/i.test(String(url))) return null;
      try {
        const r = await o.ses.fetch(url);
        return this.writeDrag(Buffer.from(await r.arrayBuffer()), r.headers.get('content-type') || '');
      } catch { return null; }
    });
    ipcMain.on('um:drag-start', (e, file) => {
      if (typeof file !== 'string' || !file.startsWith(this.dragDir) || !fs.existsSync(file)) return;
      let icon = nativeImage.createFromPath(file);
      if (icon.isEmpty()) {
        const buf = Buffer.alloc(40 * 40 * 4);
        for (let i = 0; i < buf.length; i += 4) { buf[i] = 0xf7; buf[i + 1] = 0xb5; buf[i + 2] = 0x5e; buf[i + 3] = 0xff; }
        icon = nativeImage.createFromBitmap(buf, { width: 40, height: 40 });
      } else icon = icon.resize({ width: 64 });
      try { e.sender.startDrag({ file, icon }); } catch { /* the mouse was released already */ }
    });
  }

  attach(key, contents, ses) {
    this.owners.set(contents.id, { key, ses });
    if (ses.__umDownloads) return;
    ses.__umDownloads = true;
    ses.on('will-download', (_e, item) => this.onDownload(item));
  }
  detach(id) { this.owners.delete(id); }

  desktop() { return app.getPath('desktop'); }

  // A click on Download, or "Save" in the page's own right click menu: straight to the Desktop.
  onDownload(item) {
    const name = safeFileName(item.getFilename(), 'file');
    const dest = uniquePath(this.desktop(), name);
    item.setSavePath(dest);
    item.once('done', (_ev, state) => { if (state === 'completed') this.notify(`Saved to Desktop: ${path.basename(dest)}`); });
  }

  writeDrag(buf, type) {
    fs.mkdirSync(this.dragDir, { recursive: true });
    for (const f of fs.readdirSync(this.dragDir)) { // old drag files are not needed any more
      const p = path.join(this.dragDir, f);
      try { if (Date.now() - fs.statSync(p).mtimeMs > 3600e3) fs.rmSync(p, { force: true }); } catch { /* in use */ }
    }
    const ext = EXT[String(type || '').split(';')[0].toLowerCase()] || '.jpg';
    const file = uniquePath(this.dragDir, `image-${stamp()}${ext}`);
    fs.writeFileSync(file, buf);
    return file;
  }
}

let instance = null;
function webFiles(notify) {
  if (!instance) instance = new WebFiles(notify);
  else instance.notify = notify;
  return instance;
}

module.exports = { webFiles };
