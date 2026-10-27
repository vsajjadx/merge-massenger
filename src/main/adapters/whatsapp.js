const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const pino = require('pino');
const QRCode = require('qrcode');
const { mimeFor, extFor, toNum } = require('../shared');

const IGNORED = /@(broadcast|newsletter)$/;
const prettyJid = (jid) => (jid ? '+' + jid.split('@')[0].split(':')[0] : '');

class WhatsAppAdapter extends EventEmitter {
  constructor({ authDir }) {
    super();
    this.source = 'wa';
    this.authDir = authDir;
    this.sock = null;
    this.baileys = null;
    this.logger = pino({ level: 'silent' });
    this.contacts = new Map();   // jid -> saved contact name
    this.push = new Map();       // jid -> self-chosen WhatsApp name
    this.groups = new Map();     // jid -> group subject
    this.groupLookups = new Set();
    this.lastIn = new Map();     // jid -> { key, ts } latest incoming message, needed to send read receipts
  }

  setStatus(state, extra) { this.emit('status', { source: 'wa', state, ...extra }); }
  provide() {}

  async start() {
    if (this.sock) return;
    this.baileys = this.baileys || (await import('@whiskeysockets/baileys'));
    const b = this.baileys;
    const makeWASocket = b.default;
    const { state, saveCreds } = await b.useMultiFileAuthState(this.authDir);
    const { version } = await b.fetchLatestBaileysVersion().catch(() => ({}));

    this.setStatus('connecting');
    const sock = makeWASocket({
      auth: state, version, logger: this.logger, browser: b.Browsers.macOS('Desktop'),
      syncFullHistory: false, markOnlineOnConnect: false, generateHighQualityLinkPreview: false,
    });
    this.sock = sock;

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', (u) => this.onConnection(u).catch(() => {}));
    sock.ev.on('contacts.upsert', (cs) => this.learn(cs));
    sock.ev.on('contacts.update', (cs) => this.learn(cs));
    sock.ev.on('messaging-history.set', ({ chats, contacts, messages }) => {
      this.learn(contacts || []);
      this.emitChats(chats || []);
      for (const m of messages || []) this.ingest(m, false);
    });
    sock.ev.on('chats.upsert', (cs) => this.emitChats(cs));
    sock.ev.on('chats.update', (cs) => this.emitChats(cs));
    sock.ev.on('messages.upsert', ({ messages, type }) => {
      for (const m of messages) this.ingest(m, type === 'notify');
    });
  }

  async onConnection(u) {
    if (u.qr) this.setStatus('need_qr', { qr: await QRCode.toDataURL(u.qr, { margin: 1, width: 280 }) });
    if (u.connection === 'open') this.setStatus('ready');
    if (u.connection === 'close') {
      const code = u.lastDisconnect && u.lastDisconnect.error && u.lastDisconnect.error.output
        ? u.lastDisconnect.error.output.statusCode : 0;
      this.sock = null;
      if (code === this.baileys.DisconnectReason.loggedOut) {
        fs.rmSync(this.authDir, { recursive: true, force: true }); // logged out on the phone: start a fresh QR login
      }
      this.setStatus('connecting');
      setTimeout(() => this.start().catch((err) => this.setStatus('error', { error: err.message })), 2000);
    }
  }

  learn(cs) {
    for (const c of cs) {
      if (!c.id) continue;
      const name = c.name || c.verifiedName;
      if (name) this.contacts.set(c.id, name);
      else if (c.notify) this.push.set(c.id, c.notify);
    }
  }

  titleOf(jid, given) {
    return given || this.groups.get(jid) || this.contacts.get(jid) || this.push.get(jid) || prettyJid(jid);
  }

  emitChats(chats) {
    const items = [];
    for (const c of chats) {
      if (!c.id || c.id === 'status@broadcast' || IGNORED.test(c.id)) continue;
      const isGroup = c.id.endsWith('@g.us');
      if (c.name) (isGroup ? this.groups : this.contacts).set(c.id, c.name);
      items.push({
        nativeId: c.id, title: this.titleOf(c.id, c.name), isGroup,
        unread: typeof c.unreadCount === 'number' ? Math.max(c.unreadCount, 0) : null,
        lastTs: toNum(c.conversationTimestamp), last: null,
      });
      if (isGroup && !this.groups.has(c.id)) this.lookupGroup(c.id);
    }
    if (items.length) this.emit('chats', items);
  }

  // Group names are not always in the history sync; ask once per group.
  lookupGroup(jid) {
    if (this.groupLookups.has(jid) || !this.sock) return;
    this.groupLookups.add(jid);
    this.sock.groupMetadata(jid).then((md) => {
      this.groups.set(jid, md.subject);
      this.emit('chats', [{ nativeId: jid, title: md.subject, isGroup: true, unread: null, lastTs: 0, last: null }]);
    }).catch(() => {});
  }

  ingest(m, live) {
    const b = this.baileys;
    const jid = m.key && m.key.remoteJid;
    if (!jid || jid === 'status@broadcast' || IGNORED.test(jid)) return null;
    const content = b.normalizeMessageContent(m.message);
    if (!content) return null;
    const type = b.getContentType(content);
    const isGroup = jid.endsWith('@g.us');
    const out = !!m.key.fromMe;
    const id = m.key.id;
    let text = '';
    let media = null;
    const thumbOf = (t) => (t ? 'data:image/jpeg;base64,' + (typeof t === 'string' ? t : Buffer.from(t).toString('base64')) : undefined);

    if (type === 'conversation') text = content.conversation;
    else if (type === 'extendedTextMessage') text = content.extendedTextMessage.text || '';
    else if (type === 'imageMessage') {
      const x = content.imageMessage;
      text = x.caption || '';
      media = { kind: 'image', name: `photo-${id}${extFor(x.mimetype) || '.jpg'}`, size: toNum(x.fileLength), mime: x.mimetype, thumb: thumbOf(x.jpegThumbnail) };
    } else if (type === 'videoMessage') {
      const x = content.videoMessage;
      text = x.caption || '';
      media = { kind: 'video', name: `video-${id}${extFor(x.mimetype) || '.mp4'}`, size: toNum(x.fileLength), mime: x.mimetype, thumb: thumbOf(x.jpegThumbnail) };
    } else if (type === 'audioMessage') {
      const x = content.audioMessage;
      media = { kind: x.ptt ? 'voice' : 'audio', name: `${x.ptt ? 'voice' : 'audio'}-${id}${extFor((x.mimetype || '').split(';')[0]) || '.ogg'}`, size: toNum(x.fileLength), mime: x.mimetype };
    } else if (type === 'documentMessage') {
      const x = content.documentMessage;
      text = x.caption || '';
      media = { kind: 'file', name: x.fileName || `document-${id}`, size: toNum(x.fileLength), mime: x.mimetype, thumb: thumbOf(x.jpegThumbnail) };
    } else if (type === 'stickerMessage') {
      const x = content.stickerMessage;
      media = { kind: 'sticker', name: `sticker-${id}.webp`, size: toNum(x.fileLength), mime: x.mimetype };
    } else return null; // reactions, protocol messages, polls, ...

    if (!out && !isGroup && m.pushName) this.push.set(jid, m.pushName);
    const ts = toNum(m.messageTimestamp);
    if (!out) {
      const prev = this.lastIn.get(jid);
      if (!prev || ts >= prev.ts) this.lastIn.set(jid, { key: m.key, ts });
    }
    const participant = m.key.participant || m.participant;
    const sender = out ? 'Me' : isGroup ? m.pushName || this.contacts.get(participant) || prettyJid(participant) : this.titleOf(jid);

    this.emit('message', {
      chat: { nativeId: jid, title: this.titleOf(jid), isGroup }, nativeId: id, sender, text, ts, out, live, media,
      raw: media ? JSON.stringify(m, b.BufferJSON.replacer) : null,
    });
    if (isGroup && !this.groups.has(jid)) this.lookupGroup(jid);
    return true;
  }

  alive() {
    if (!this.sock) throw new Error('WhatsApp is not connected');
    return this.sock;
  }

  async markRead(jid) {
    const last = this.lastIn.get(jid);
    if (last && this.sock) await this.sock.readMessages([last.key]);
  }

  async sendText(jid, text) {
    const sent = await this.alive().sendMessage(jid, { text });
    if (sent) this.ingest(sent, true);
  }

  async sendFile(jid, filePath, caption) {
    const mime = mimeFor(filePath);
    const source = { url: filePath }; // local path, streamed from disk
    let content;
    if (mime.startsWith('image/')) content = { image: source, caption };
    else if (mime.startsWith('video/')) content = { video: source, caption };
    else if (mime.startsWith('audio/')) content = { audio: source, mimetype: mime };
    else content = { document: source, fileName: path.basename(filePath), mimetype: mime, caption };
    const sent = await this.alive().sendMessage(jid, content);
    if (sent) this.ingest(sent, true);
  }

  async download(msg, destPath) {
    const b = this.baileys;
    const sock = this.alive();
    if (!msg.raw) throw new Error('This file can no longer be downloaded');
    const m = JSON.parse(msg.raw, b.BufferJSON.reviver);
    const stream = await b.downloadMediaMessage(m, 'stream', {}, { logger: this.logger, reuploadRequest: sock.updateMediaMessage });
    await pipeline(stream, fs.createWriteStream(destPath));
  }

  // WhatsApp only delivers history it chooses to sync; there is nothing to request per chat.
  async loadHistory() {}
}

module.exports = { WhatsAppAdapter };
