const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { previewOf } = require('./shared');

// The hub is the only thing that talks to the adapters. It normalises their events into
// the shared store, so the UI never needs to know which service a chat came from.
//
// Adapter contract (see adapters/_template.js):
//   adapter.source                       'tg' | 'wa' | ...
//   adapter.start()                      connect (may wait for login input)
//   events: 'status' {source,state,...} | 'chats' [chatInfo] | 'message' msgInfo
//   adapter.loadHistory(nativeChatId, limit)
//   adapter.sendText(nativeChatId, text) / sendFile(nativeChatId, filePath, caption)
//   adapter.download(msg, destPath)
//   adapter.markRead(nativeChatId)
//   adapter.provide(kind, value)         answers login prompts
class Hub extends EventEmitter {
  constructor({ store, cache, adapters }) {
    super();
    this.store = store;
    this.cache = cache;
    this.adapters = new Map(adapters.map((a) => [a.source, a]));
    this.statuses = {};
    this.inflight = new Map();
  }

  async start() {
    for (const a of this.adapters.values()) {
      a.on('status', (s) => { this.statuses[s.source] = s; this.emit('status', s); });
      a.on('chats', (items) => this.onChats(a.source, items));
      a.on('message', (m) => this.onMessage(a.source, m));
    }
    await Promise.all([...this.adapters.values()].map((a) =>
      Promise.resolve().then(() => a.start()).catch((err) => {
        const s = { source: a.source, state: 'error', error: err.message };
        this.statuses[a.source] = s;
        this.emit('status', s);
      })));
  }

  adapterFor(chatId) {
    const a = this.adapters.get(chatId.slice(0, 2));
    if (!a) throw new Error('Unknown account for this chat');
    return a;
  }
  nativeId(chatId) { return chatId.slice(3); }

  onChats(source, items) {
    for (const c of items) {
      const id = `${source}:${c.nativeId}`;
      this.store.upsertChat({ id, source, nativeId: c.nativeId, title: c.title, isGroup: c.isGroup, unread: c.unread });
      if (c.lastTs) this.store.touchLast(id, c.lastTs, c.last ? previewOf(c.last) : null, c.last ? c.last.out : null);
      this.emit('chat', this.store.getChat(id));
    }
  }

  onMessage(source, m) {
    const chatId = `${source}:${m.chat.nativeId}`;
    const id = `${chatId}:${m.nativeId}`;
    this.store.upsertChat({ id: chatId, source, nativeId: m.chat.nativeId, title: m.chat.title, isGroup: m.chat.isGroup });
    const isNew = this.store.upsertMessage({
      id, chatId, nativeId: m.nativeId, sender: m.sender, text: m.text, ts: m.ts, out: m.out, media: m.media, raw: m.raw,
    });
    this.store.touchLast(chatId, m.ts, previewOf(m), m.out);
    const bump = isNew && m.live && !m.out;
    if (bump) this.store.bumpUnread(chatId);
    const chat = this.store.getChat(chatId);
    this.emit('message', this.store.getMessage(id));
    this.emit('chat', chat);
    if (bump) this.emit('incoming', chat, previewOf(m));
  }

  listChats() { return this.store.listChats(); }
  messages(chatId, before) { return this.store.page(chatId, before, 60); }

  async openChat(chatId) {
    this.store.markRead(chatId);
    this.emit('chat', this.store.getChat(chatId));
    const a = this.adapterFor(chatId);
    const native = this.nativeId(chatId);
    Promise.resolve(a.markRead && a.markRead(native)).catch(() => {});
    // Fetch recent history in the background; the UI reloads when 'history' fires.
    Promise.resolve(a.loadHistory && a.loadHistory(native, 50))
      .then(() => this.emit('history', chatId))
      .catch((err) => this.emit('problem', `Could not load history: ${err.message}`));
    return this.messages(chatId);
  }

  markRead(chatId) {
    this.store.markRead(chatId);
    this.emit('chat', this.store.getChat(chatId));
    const a = this.adapterFor(chatId);
    Promise.resolve(a.markRead && a.markRead(this.nativeId(chatId))).catch(() => {});
  }

  setPinned(chatId, pinned) {
    this.store.setPinned(chatId, pinned);
    this.emit('chats-reload');
  }

  sendText(chatId, text) { return this.adapterFor(chatId).sendText(this.nativeId(chatId), text); }

  async sendFiles(chatId, files, caption) {
    const a = this.adapterFor(chatId);
    for (let i = 0; i < files.length; i++) {
      if (!fs.statSync(files[i]).isFile()) throw new Error(`${path.basename(files[i])} is not a file`);
      await a.sendFile(this.nativeId(chatId), files[i], i === 0 ? caption : '');
    }
  }

  // Downloads only happen here, and only when the UI asks (a click).
  download(msgId) {
    if (this.inflight.has(msgId)) return this.inflight.get(msgId);
    const job = (async () => {
      const row = this.store.getMessageRow(msgId);
      if (!row || !row.media) throw new Error('This message has no file');
      const existing = this.cache.existing(msgId);
      if (existing) return this.store.getMessage(msgId);
      const media = JSON.parse(row.media);
      const dest = this.cache.destFor(msgId, media);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const a = this.adapterFor(row.chat_id);
      try {
        await a.download({ nativeChatId: this.nativeId(row.chat_id), nativeId: row.native_id, raw: row.raw, media }, dest);
      } catch (err) {
        fs.rmSync(path.dirname(dest), { recursive: true, force: true });
        throw err;
      }
      this.cache.register(msgId, dest);
      this.cache.prune(msgId);
      const dto = this.store.getMessage(msgId);
      this.emit('message', dto);
      return dto;
    })().finally(() => this.inflight.delete(msgId));
    this.inflight.set(msgId, job);
    return job;
  }

  provide(source, kind, value) {
    const a = this.adapters.get(source);
    if (!a) throw new Error('Unknown account');
    return a.provide(kind, value);
  }
}

module.exports = { Hub };
