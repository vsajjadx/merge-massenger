const test = require('node:test');
const assert = require('node:assert/strict');
const { shortcutAction } = require('../src/main/shortcuts');

test('application shortcuts use physical keys with Persian keyboard input', () => {
  for (const [code, key, action] of [['Comma', 'و', 'settings'], ['KeyK', 'ن', 'search'], ['Digit1', '۱', 'all'], ['KeyR', 'ق', 'reload']]) {
    assert.equal(shortcutAction({ type: 'keyDown', control: true, code, key }), action);
  }
});

test('shortcut fallback supports English input and ignores ordinary typing, releases and AltGr', () => {
  assert.equal(shortcutAction({ type: 'keyDown', control: true, key: 'K' }), 'search');
  assert.equal(shortcutAction({ type: 'keyDown', meta: true, key: ',' }), 'settings');
  assert.equal(shortcutAction({ type: 'keyDown', code: 'KeyK', key: 'k' }), null);
  assert.equal(shortcutAction({ type: 'keyUp', control: true, code: 'KeyK' }), null);
  assert.equal(shortcutAction({ type: 'keyDown', control: true, alt: true, code: 'KeyK' }), null);
  assert.equal(shortcutAction({ type: 'keyDown', control: true, key: 'x' }), null);
});
