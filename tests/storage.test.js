const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Store } = require('../src/main/db');
const { DownloadCache } = require('../src/main/cache');
const { safeFileName } = require('../src/main/shared');

test('Windows file names stay usable and cannot contain path separators', () => {
  assert.equal(safeFileName('CON.txt'), '_CON.txt');
  assert.equal(safeFileName('lpt9'), '_lpt9');
  assert.equal(safeFileName('../photo?.jpg. '), '_photo_.jpg');
  assert.equal(safeFileName('', 'file.pdf'), 'file.pdf');
  assert.ok(safeFileName('a'.repeat(300) + '.pdf').length <= 180);
});

test('Stored chats, read state, pins and downloaded media survive reopening', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'um-storage-test-'));
  let store;
  try {
    store = new Store(path.join(dir, 'messages.db'));
    store.upsertChat({ id: 'tg:1', source: 'tg', nativeId: '1', title: 'Team', unread: 2 });
    store.upsertChat({ id: 'wa:2', source: 'wa', nativeId: '2', title: 'Design' });
    store.touchLast('wa:2', 200, 'Latest', false);
    store.setPinned('tg:1', true);
    store.markRead('tg:1');
    const message = { id: 'tg:1:1', chatId: 'tg:1', nativeId: '1', ts: 100, text: 'Hello', out: false };
    assert.equal(store.upsertMessage(message), true);
    assert.equal(store.upsertMessage({ ...message, text: 'Edited' }), false);
    store.db.close();
    store = new Store(path.join(dir, 'messages.db'));
    assert.deepEqual(store.listChats().map(c => c.id), ['tg:1', 'wa:2']);
    assert.equal(store.getChat('tg:1').unread, 0);
    assert.equal(store.page('tg:1', undefined, 60)[0].text, 'Edited');
    const cache = new DownloadCache(path.join(dir, 'cache'), store, 3);
    for (const id of ['tg:1:1', 'tg:1:2']) {
      const dest = cache.destFor(id, { name: 'file.txt' });
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, 'abc');
      cache.register(id, dest);
    }
    cache.prune('tg:1:2');
    assert.equal(store.totalBytes(), 3);
    assert.equal(cache.existing('tg:1:1'), null);
    assert.ok(cache.existing('tg:1:2'));
    const outside = path.join(dir, 'keep.txt');
    fs.writeFileSync(outside, 'keep');
    store.setFile('bad-row', outside, 4);
    cache.clear();
    assert.equal(fs.readFileSync(outside, 'utf8'), 'keep');
    assert.equal(store.totalBytes(), 0);
  } finally {
    store?.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
