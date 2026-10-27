// Template for a new messenger. Copy it, fill the methods in, and add an instance to the
// `adapters` array in main.js. Nothing else in the app needs to change: the hub, the
// database, the chat list and the UI only see the events below.
//
// Event shapes (all `ts` values are Unix seconds):
//   emit('status',  { source, state: 'connecting' | 'need_<kind>' | 'ready' | 'error', ...extra })
//   emit('chats',   [{ nativeId, title, isGroup, unread, lastTs, last: { text, media, out } }])
//   emit('message', { chat: { nativeId, title, isGroup }, nativeId, sender, text, ts, out, live,
//                     media: { kind: 'image'|'video'|'voice'|'audio'|'sticker'|'file', name, size, mime, thumb? } | null,
//                     raw?: string })          // raw: anything download() needs later, stored as text
const { EventEmitter } = require('events');

class TemplateAdapter extends EventEmitter {
  constructor() { super(); this.source = 'xx'; /* two letters, unique */ }
  async start() { throw new Error('not implemented'); }
  provide(kind, value) { /* receive login input from the UI (phone, code, ...) */ }
  async loadHistory(nativeChatId, limit) {}
  async sendText(nativeChatId, text) { throw new Error('not implemented'); }
  async sendFile(nativeChatId, filePath, caption) { throw new Error('not implemented'); }
  async download(msg, destPath) { throw new Error('not implemented'); } // write the file to destPath
  async markRead(nativeChatId) {}
}

module.exports = { TemplateAdapter };
