const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { safeFileName, extFor } = require('./shared');

// Downloaded files live in <dir>/<hash of message id>/<original name>.
// Keeping the original name is what makes drag-out to Explorer/Finder produce a properly named file.
class DownloadCache {
  constructor(dir, store, maxBytes) {
    this.dir = dir;
    this.store = store;
    this.maxBytes = maxBytes;
    fs.mkdirSync(dir, { recursive: true });
  }

  destFor(msgId, media) {
    const fallback = `${media.kind || 'file'}${extFor(media.mime)}`;
    const name = safeFileName(media.name, fallback);
    const folder = crypto.createHash('sha1').update(msgId).digest('hex').slice(0, 16);
    return path.join(this.dir, folder, name);
  }

  existing(msgId) {
    const f = this.store.getFile(msgId);
    if (!f) return null;
    if (!fs.existsSync(f.path)) { this.store.deleteFile(msgId); return null; }
    this.store.touchFile(msgId);
    return f.path;
  }

  register(msgId, filePath) {
    this.store.setFile(msgId, filePath, fs.statSync(filePath).size);
  }

  // Deletes least-recently-used files until the cache fits under the cap.
  prune(keepMsgId) {
    let total = this.store.totalBytes();
    if (total <= this.maxBytes) return;
    for (const f of this.store.lruFiles()) {
      if (total <= this.maxBytes) break;
      if (f.msg_id === keepMsgId) continue;
      this.remove(f);
      total -= f.size;
    }
  }

  remove(f) {
    fs.rmSync(path.dirname(f.path), { recursive: true, force: true });
    this.store.deleteFile(f.msg_id);
  }

  clear() {
    for (const f of this.store.lruFiles()) this.remove(f);
  }
}

module.exports = { DownloadCache };
