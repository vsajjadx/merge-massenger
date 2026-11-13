const path = require('path');

const MIME_BY_EXT = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.m4a': 'audio/mp4', '.wav': 'audio/wav',
  '.pdf': 'application/pdf', '.zip': 'application/zip', '.txt': 'text/plain',
};
const EXT_BY_MIME = Object.fromEntries(Object.entries(MIME_BY_EXT).map(([e, m]) => [m, e]));
EXT_BY_MIME['image/jpeg'] = '.jpg';

const mimeFor = (file) => MIME_BY_EXT[path.extname(file).toLowerCase()] || 'application/octet-stream';
const extFor = (mime) => EXT_BY_MIME[mime] || '';

const toNum = (v) => (typeof v === 'number' ? v : v && typeof v.toNumber === 'function' ? v.toNumber() : Number(v) || 0);

const KIND_LABEL = { image: 'Photo', video: 'Video', voice: 'Voice message', audio: 'Audio', sticker: 'Sticker', file: 'File' };

function previewOf(m) {
  if (!m) return '';
  if (m.text) return m.text.replace(/\s+/g, ' ').slice(0, 140);
  if (m.media) return m.media.kind === 'file' && m.media.name ? m.media.name : KIND_LABEL[m.media.kind] || 'File';
  return '';
}

// Strip path separators and characters Windows refuses in file names.
function safeFileName(name, fallback) {
  let cleaned = String(name || '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/^\.+/, '').trim().replace(/[. ]+$/, '');
  if (!cleaned) cleaned = String(fallback || 'file').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/[. ]+$/, '') || 'file';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(cleaned)) cleaned = '_' + cleaned;
  // Leave room for a collision suffix and avoid a trailing split surrogate.
  if (cleaned.length > 180) {
    const ext = path.extname(cleaned).slice(0, 20);
    cleaned = cleaned.slice(0, 180 - ext.length).replace(/[\uD800-\uDBFF]$/, '') + ext;
  }
  return cleaned;
}

module.exports = { mimeFor, extFor, toNum, previewOf, safeFileName };
