const fs = require('node:fs');
const path = require('node:path');

const BOOLEAN_KEYS = ['compact', 'notifications', 'closeToTray', 'launchAtLogin', 'downloadPrompt'];

function defaults(desktop) {
  return {
    theme: 'dark', language: 'en', compact: false, notifications: true,
    closeToTray: true, launchAtLogin: false, downloadPath: desktop,
    downloadPrompt: false,
  };
}

function validatePatch(patch, strict = true) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Settings must be an object');
  const result = {};
  for (const [key, value] of Object.entries(patch)) {
    let valid = false;
    if (BOOLEAN_KEYS.includes(key)) valid = typeof value === 'boolean';
    else if (key === 'theme') valid = ['dark', 'light', 'system'].includes(value);
    else if (key === 'language') valid = ['fa', 'en'].includes(value);
    else if (key === 'downloadPath') valid = typeof value === 'string' && value.length < 2048 && !/[\x00-\x1f]/.test(value) && path.isAbsolute(value);
    if (!valid) { if (strict) throw new Error(`Invalid setting: ${key}`); else continue; }
    result[key] = key === 'downloadPath' ? path.normalize(value) : value;
  }
  return result;
}

function windowState(state) {
  if (!state || typeof state !== 'object') return null;
  const bounds = {};
  for (const key of ['x', 'y', 'width', 'height']) {
    if (!Number.isInteger(state[key]) || Math.abs(state[key]) > 50000) return null;
    bounds[key] = state[key];
  }
  if (bounds.width < 820 || bounds.height < 520) return null;
  return { ...bounds, maximized: state.maximized === true };
}

class Preferences {
  constructor(file, desktop) {
    this.file = file;
    this.value = defaults(desktop);
    this.window = null;
    for (const candidate of [file, `${file}.bak`]) {
      try {
        const data = JSON.parse(fs.readFileSync(candidate, 'utf8'));
        this.value = { ...this.value, ...validatePatch(data.preferences, false) };
        this.window = windowState(data.window);
        break;
      } catch { /* first launch or damaged settings: try the backup before defaults */ }
    }
  }
  get() { return { ...this.value }; }
  update(patch) {
    const next = { ...this.value, ...validatePatch(patch) };
    this.persist(next, this.window);
    this.value = next;
    return this.get();
  }
  saveWindow(state) {
    const next = windowState(state);
    if (!next) return;
    this.persist(this.value, next);
    this.window = next;
  }
  persist(preferences, window) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ preferences, window }, null, 2), { encoding: 'utf8', mode: 0o600 });
    // Keep the last successfully read settings if a future write is interrupted.
    if (fs.existsSync(this.file)) {
      try {
        const previous = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        validatePatch(previous.preferences, false);
        fs.copyFileSync(this.file, `${this.file}.bak`);
      } catch { /* preserve the valid backup when the main file was damaged */ }
    }
    fs.renameSync(temporary, this.file);
  }
}

module.exports = { Preferences, defaults, validatePatch, windowState };
