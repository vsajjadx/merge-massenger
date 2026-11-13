const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Preferences, validatePatch, windowState } = require('../src/main/preferences');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unified-preferences-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'preferences.json');
  return { dir, file, settings: new Preferences(file, dir) };
}

test('new profiles save directly to the supplied Desktop and retain a custom folder after restart', (t) => {
  const { dir, file } = fixture(t);
  const desktop = path.join(dir, 'Desktop');
  const settings = new Preferences(file, desktop);
  assert.equal(settings.get().downloadPath, desktop);
  const custom = path.join(dir, 'custom folder');
  settings.update({ downloadPath: custom });
  assert.equal(new Preferences(file, desktop).get().downloadPath, custom);
});

test('preferences persist changes and window bounds across restarts', (t) => {
  const { dir, file, settings } = fixture(t);
  assert.equal(settings.get().language, 'en');
  assert.equal(settings.get().theme, 'dark');
  settings.update({ notifications: false, downloadPath: path.join(dir, 'my downloads'), theme: 'light' });
  settings.saveWindow({ x: -1300, y: 100, width: 1000, height: 700, maximized: true });
  const restored = new Preferences(file, dir);
  assert.equal(restored.get().notifications, false);
  assert.equal(restored.get().theme, 'light');
  assert.equal(restored.get().downloadPath, path.join(dir, 'my downloads'));
  assert.equal(restored.window.x, -1300);
  assert.equal(restored.window.maximized, true);
  assert.equal(fs.existsSync(`${file}.tmp`), false);
});

test('invalid updates are rejected without changing saved settings', (t) => {
  const { file, settings } = fixture(t);
  settings.update({ compact: true });
  const previous = fs.readFileSync(file, 'utf8');
  for (const value of [{ theme: 'neon' }, { notifications: 'yes' }, { downloadPath: '../escape' }, { downloadPath: `${path.resolve('downloads')}\0` }, { unknown: true }, null, []]) {
    assert.throws(() => settings.update(value));
    assert.equal(fs.readFileSync(file, 'utf8'), previous);
  }
  assert.equal(settings.get().compact, true);
});

test('damaged settings recover the previous valid backup', (t) => {
  const { dir, file, settings } = fixture(t);
  settings.update({ theme: 'light' });
  settings.update({ compact: true });
  fs.writeFileSync(file, '{corrupted');
  const recovered = new Preferences(file, dir);
  assert.equal(recovered.get().theme, 'light');
  assert.equal(recovered.get().compact, false);
  recovered.update({ downloadPrompt: true });
  fs.writeFileSync(file, '{damaged again');
  assert.equal(new Preferences(file, dir).get().theme, 'light');
});

test('loading ignores unknown fields and invalid bounds; snapshots cannot mutate state', (t) => {
  const { dir, file } = fixture(t);
  fs.writeFileSync(file, JSON.stringify({ preferences: { theme: 'system', compact: true, future: 10, closeToTray: 'yes' }, window: { x: 0, y: 0, width: 20, height: 20 } }));
  const settings = new Preferences(file, dir);
  assert.equal(settings.get().theme, 'system');
  assert.equal(settings.get().compact, true);
  assert.equal(settings.get().closeToTray, true);
  assert.equal(settings.window, null);
  const copy = settings.get(); copy.compact = false;
  assert.equal(settings.get().compact, true);
  assert.deepEqual(validatePatch({ compact: 3 }, false), {});
  assert.equal(windowState({ x: Infinity, y: 0, width: 1000, height: 700 }), null);
});
