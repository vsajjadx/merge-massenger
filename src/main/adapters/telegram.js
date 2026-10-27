const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const { CustomFile } = require('telegram/client/uploads');

const displayName = (e) => (e && (e.title || [e.firstName, e.lastName].filter(Boolean).join(' ') || e.username)) || '';

class TelegramAdapter extends EventEmitter {
  constructor({ secrets }) {
    super();
    this.source = 'tg';
    this.secrets = secrets;
    this.client = null;
    this.peers = new Map();    // chat id -> InputPeer, needed for every API call
    this.waiters = new Map();  // login prompts waiting for the UI
    this.timer = null;
  }

  setStatus(state, extra) { this.emit('status', { source: 'tg', state, ...extra }); }

  ask(kind) {
    this.setStatus('need_' + kind);
    return new Promise((resolve) => this.waiters.set(kind, resolve));
  }

  provide(kind, value) {
    if (kind === 'config') {
      this.secrets.set('tg.apiId', String(value.apiId).trim());
      this.secrets.set('tg.apiHash', String(value.apiHash).trim());
      return this.start();
    }
    const w = this.waiters.get(kind);
    if (w) { this.waiters.delete(kind); w(String(value).trim()); }
  }

  async start() {
    if (this.client) return;
    const apiId = Number(this.secrets.get('tg.apiId'));
    const apiHash = this.secrets.get('tg.apiHash');
    if (!apiId || !apiHash) return this.setStatus('need_config');

    this.setStatus('connecting');
    const client = new TelegramClient(new StringSession(this.secrets.get('tg.session') || ''), apiId, apiHash, { connectionRetries: 5 });
    this.client = client;
    try {
      await client.start({
        phoneNumber: () => this.ask('phone'),
        phoneCode: () => this.ask('code'),
        password: () => this.ask('password'),
        onError: (err) => { this.setStatus('error', { error: err.message }); return false; }, // false = let the user retry
      });
    } catch (err) {
      this.client = null;
      this.setStatus('error', { error: err.message });
      return;
    }
    this.secrets.set('tg.session', client.session.save());
    this.setStatus('ready');
    client.addEventHandler((ev) => this.onNew(ev.message).catch(() => {}), new NewMessage({}));
    await this.syncDialogs();
    this.timer = setInterval(() => this.syncDialogs().catch(() => {}), 5 * 60 * 1000); // keeps unread counts and titles fresh
  }

  async syncDialogs() {
    const dialogs = await this.client.getDialogs({ limit: 100 });
    const chats = [];
    const messages = [];
    for (const d of dialogs) {
      const id = String(d.id);
      this.peers.set(id, d.inputEntity);
      const info = { nativeId: id, title: d.title || d.name || id, isGroup: !!(d.isGroup || d.isChannel) };
      const msg = this.toMsg(d.message, info, false);
      chats.push({ ...info, unread: d.unreadCount || 0, lastTs: d.date || 0, last: msg ? { text: msg.text, media: msg.media, out: msg.out } : null });
      if (msg) messages.push(msg);
    }
    this.emit('chats', chats);
    for (const m of messages) this.emit('message', m);
  }

  toMsg(m, chat, live, sender) {
    if (!m || m.className === 'MessageEmpty') return null;
    let media = null;
    const f = m.media ? m.file : null;
    if (f) {
      const kind = m.photo ? 'image' : m.voice ? 'voice' : m.audio ? 'audio' : m.video ? 'video' : m.sticker ? 'sticker' : 'file';
      media = { kind, name: f.name || `${kind}${f.ext || ''}`, size: f.size ? Number(f.size) : 0, mime: f.mimeType || '' };
    }
    const text = m.message || '';
    if (!text && !media) return null; // service messages, polls, etc.
    return {
      chat, nativeId: String(m.id), sender: m.out ? 'Me' : sender || chat.title, text, ts: m.date, out: !!m.out, live, media,
    };
  }

  async onNew(m) {
    if (!m) return;
    const id = String(m.chatId);
    const chatEntity = await m.getChat().catch(() => null);
    this.peers.set(id, await m.getInputChat());
    const chat = { nativeId: id, title: displayName(chatEntity) || id, isGroup: !!(m.isGroup || m.isChannel) };
    const sender = chat.isGroup && !m.out ? displayName(await m.getSender().catch(() => null)) : '';
    const msg = this.toMsg(m, chat, true, sender);
    if (!msg) return;
    this.emit('message', msg);
    this.fetchThumb(m, msg);
  }

  // Small preview for photos only; the full file is never downloaded without a click.
  async fetchThumb(m, msg) {
    if (!m.photo) return;
    try {
      const buf = await this.client.downloadMedia(m, { thumb: 0 });
      if (buf && buf.length) {
        msg.media.thumb = 'data:image/jpeg;base64,' + Buffer.from(buf).toString('base64');
        this.emit('message', { ...msg, live: false });
      }
    } catch { /* no thumbnail is fine */ }
  }

  peer(nativeChatId) {
    const p = this.peers.get(nativeChatId);
    if (!p) throw new Error('Telegram chat is not loaded yet, try again in a moment');
    return p;
  }

  async loadHistory(nativeChatId, limit) {
    const msgs = await this.client.getMessages(this.peer(nativeChatId), { limit });
    let thumbs = 0;
    for (const m of msgs) {
      const chat = { nativeId: nativeChatId };
      const sender = m.isGroup || m.isChannel ? displayName(m.sender) : '';
      const msg = this.toMsg(m, chat, false, sender);
      if (!msg) continue;
      this.emit('message', msg);
      if (m.photo && thumbs++ < 20) await this.fetchThumb(m, msg);
    }
  }

  async markRead(nativeChatId) { await this.client.markAsRead(this.peer(nativeChatId)); }

  async sendText(nativeChatId, text) {
    const sent = await this.client.sendMessage(this.peer(nativeChatId), { message: text });
    this.emitSent(nativeChatId, sent);
  }

  async sendFile(nativeChatId, filePath, caption) {
    const size = fs.statSync(filePath).size;
    const sent = await this.client.sendFile(this.peer(nativeChatId), {
      file: new CustomFile(path.basename(filePath), size, filePath), caption: caption || '', forceDocument: false,
    });
    this.emitSent(nativeChatId, sent);
  }

  emitSent(nativeChatId, sent) {
    const msg = this.toMsg(sent, { nativeId: nativeChatId }, true);
    if (msg) this.emit('message', msg);
  }

  async download(msg, destPath) {
    const [m] = await this.client.getMessages(this.peer(msg.nativeChatId), { ids: [Number(msg.nativeId)] });
    if (!m || !m.media) throw new Error('This file is no longer available on Telegram');
    await this.client.downloadMedia(m, { outputFile: destPath });
  }
}

module.exports = { TelegramAdapter };
