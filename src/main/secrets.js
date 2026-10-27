const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');

// Small key/value store for credentials (Telegram api_id/api_hash/session).
// Values are encrypted with the OS keychain via Electron's safeStorage when it is available.
let data = null;
const file = () => path.join(app.getPath('userData'), 'secrets.json');

function load() {
  if (data) return data;
  try { data = JSON.parse(fs.readFileSync(file(), 'utf8')); } catch { data = {}; }
  return data;
}
function flush() { fs.writeFileSync(file(), JSON.stringify(data), { mode: 0o600 }); }

function get(key) {
  const v = load()[key];
  if (!v) return null;
  try {
    return v.startsWith('e:')
      ? safeStorage.decryptString(Buffer.from(v.slice(2), 'base64'))
      : Buffer.from(v.slice(2), 'base64').toString('utf8');
  } catch { return null; }
}
function set(key, value) {
  load()[key] = safeStorage.isEncryptionAvailable()
    ? 'e:' + safeStorage.encryptString(String(value)).toString('base64')
    : 'p:' + Buffer.from(String(value)).toString('base64');
  flush();
}
function remove(key) { delete load()[key]; flush(); }

module.exports = { get, set, remove };
