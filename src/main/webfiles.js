const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, ipcMain, nativeImage, shell } = require('electron');
const { randomUUID } = require('crypto');
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

function downloadName(name) {
  const cleaned = safeFileName(name, 'file').replace(/[. ]+$/, '').slice(0, 180) || 'file';
  // Windows reserves these names even with a file extension.
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:[. ]|$)/i.test(cleaned) ? '_' + cleaned : cleaned;
}

// Files that come out of the web clients: downloads the user starts
// and pictures dragged out of a chat. Nothing is saved without the user asking for it.
class WebFiles {
  constructor(notify) {
    this.notify = notify;
    this.owners = new Map();    // webContents id -> { key, ses }
    this.preferences = {};
    this.reserved = new Set();
    this.downloads = new Map();
    this.onActivity = () => {};
    this.dragDir = path.join(os.tmpdir(), 'unified-messenger-drag');

    ipcMain.handle('um:drag-prepare', (e, d) => {
      if (!this.owners.has(e.sender.id) || !d || !(d.bytes instanceof ArrayBuffer) || d.bytes.byteLength > 40 * 1024 * 1024) return null;
      return this.writeDrag(Buffer.from(d.bytes), d.type);
    });
    ipcMain.handle('um:drag-prepare-url', async (e, url) => {
      const o = this.owners.get(e.sender.id);
      if (!o || !/^https:/i.test(String(url))) return null;
      try {
        const r = await o.ses.fetch(url);
        if (!r.ok || Number(r.headers.get('content-length')) > 40 * 1024 * 1024) return null;
        const chunks = [];
        let size = 0;
        for await (const chunk of r.body) {
          size += chunk.length;
          if (size > 40 * 1024 * 1024) return null;
          chunks.push(Buffer.from(chunk));
        }
        return this.writeDrag(Buffer.concat(chunks), r.headers.get('content-type') || '');
      } catch { return null; }
    });
    ipcMain.on('um:drag-start', (e, file) => {
      if (!this.owners.has(e.sender.id) || typeof file !== 'string' || path.dirname(path.resolve(file)) !== path.resolve(this.dragDir) || !fs.existsSync(file)) return;
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
    ses.on('will-download', (_e, item, source) => {
      // A removed account cannot trigger downloads through a stale session handler.
      if (!source || !this.owners.has(source.id)) { item.cancel(); return; }
      this.onDownload(item);
    });
  }
  detach(id) { this.owners.delete(id); }

  setPreferences(prefs) { this.preferences = prefs || {}; }
  getDownloads() { return [...this.downloads.values()]; }

  reveal(id) {
    const download = this.downloads.get(id);
    if (!download || download.state !== 'completed' || !download.path || !fs.existsSync(download.path)) throw new Error('The downloaded file is no longer available.');
    shell.showItemInFolder(download.path);
  }

  activity(download) {
    this.downloads.set(download.id, download);
    // Keep a small in-memory history. Active downloads are never evicted.
    if (this.downloads.size > 50) {
      for (const [id, item] of this.downloads) {
        if (!['progressing', 'paused'].includes(item.state)) this.downloads.delete(id);
        if (this.downloads.size <= 50) break;
      }
    }
    this.onActivity(download);
  }

  onDownload(item) {
    try {
      const directory = this.preferences.downloadPath || app.getPath('desktop');
      fs.mkdirSync(directory, { recursive: true });
      const name = downloadName(item.getFilename());
      const ext = path.extname(name), base = path.basename(name, ext);
      let dest = uniquePath(directory, name), i = 1;
      while (this.reserved.has(dest.toLowerCase()) || fs.existsSync(dest)) dest = path.join(directory, `${base} (${i++})${ext}`);
      this.reserved.add(dest.toLowerCase());
      if (this.preferences.downloadPrompt) item.setSaveDialogOptions({ defaultPath: dest });
      else item.setSavePath(dest);
      const download = { id: randomUUID(), name, state: 'progressing', received: 0, total: item.getTotalBytes() };
      this.activity({ ...download });
      item.on('updated', (_event, state) => {
        download.state = item.isPaused() ? 'paused' : state;
        download.received = item.getReceivedBytes();
        download.total = item.getTotalBytes();
        this.activity({ ...download });
      });
      item.once('done', (_ev, state) => {
        this.reserved.delete(dest.toLowerCase());
        download.state = state;
        download.received = item.getReceivedBytes();
        if (state === 'completed') download.path = item.getSavePath() || dest;
        this.activity({ ...download });
        if (state === 'completed') this.notify(`Saved: ${path.basename(item.getSavePath() || dest)}`);
        else if (state !== 'cancelled') this.notify('Download interrupted. Try downloading the file again.');
      });
    } catch {
      item.cancel();
      this.notify('Could not save the download. Choose a writable folder in Settings.');
    }
  }

  writeDrag(buf, type) {
    fs.mkdirSync(this.dragDir, { recursive: true });
    for (const f of fs.readdirSync(this.dragDir)) { // old drag files are not needed any more
      const p = path.join(this.dragDir, f);
      try { if (Date.now() - fs.statSync(p).mtimeMs > 3600e3) fs.rmSync(p, { force: true }); } catch { /* in use */ }
    }
    const ext = EXT[String(type || '').split(';')[0].toLowerCase()] || '.bin';
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
