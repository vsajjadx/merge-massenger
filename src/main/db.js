const { DatabaseSync } = require('node:sqlite');

const nn = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v === undefined ? null : v]));

class Store {
  constructor(file) {
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS chats (
        id TEXT PRIMARY KEY, source TEXT NOT NULL, native_id TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '', is_group INTEGER NOT NULL DEFAULT 0,
        unread INTEGER NOT NULL DEFAULT 0,
        pinned INTEGER NOT NULL DEFAULT 0, pin_order INTEGER NOT NULL DEFAULT 0,
        last_ts INTEGER NOT NULL DEFAULT 0, last_text TEXT NOT NULL DEFAULT '', last_out INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, native_id TEXT NOT NULL,
        sender TEXT NOT NULL DEFAULT '', text TEXT NOT NULL DEFAULT '',
        ts INTEGER NOT NULL, out INTEGER NOT NULL DEFAULT 0,
        media TEXT, raw TEXT
      );
      CREATE INDEX IF NOT EXISTS messages_chat_ts ON messages(chat_id, ts);
      CREATE TABLE IF NOT EXISTS files (
        msg_id TEXT PRIMARY KEY, path TEXT NOT NULL, size INTEGER NOT NULL, last_access INTEGER NOT NULL
      );
    `);
    const p = (sql) => this.db.prepare(sql);
    this.q = {
      upsertChat: p(`
        INSERT INTO chats (id, source, native_id, title, is_group, unread)
        VALUES (@id, @source, @nativeId, COALESCE(@title, ''), COALESCE(@isGroup, 0), COALESCE(@unread, 0))
        ON CONFLICT(id) DO UPDATE SET
          title = CASE WHEN @title IS NOT NULL AND @title <> '' THEN @title ELSE chats.title END,
          is_group = COALESCE(@isGroup, chats.is_group),
          unread = COALESCE(@unread, chats.unread)`),
      touchLast: p(`UPDATE chats SET last_ts = @ts, last_text = COALESCE(@text, last_text), last_out = COALESCE(@out, last_out)
                    WHERE id = @id AND @ts >= last_ts`),
      bumpUnread: p(`UPDATE chats SET unread = unread + 1 WHERE id = @id`),
      markRead: p(`UPDATE chats SET unread = 0 WHERE id = @id`),
      pin: p(`UPDATE chats SET pinned = 1, pin_order = (SELECT COALESCE(MAX(pin_order), 0) + 1 FROM chats WHERE pinned = 1) WHERE id = @id`),
      unpin: p(`UPDATE chats SET pinned = 0, pin_order = 0 WHERE id = @id`),
      getChat: p(`SELECT * FROM chats WHERE id = ?`),
      listChats: p(`SELECT * FROM chats ORDER BY pinned DESC, pin_order ASC, last_ts DESC`),
      hasMessage: p(`SELECT 1 FROM messages WHERE id = ?`),
      upsertMessage: p(`
        INSERT INTO messages (id, chat_id, native_id, sender, text, ts, out, media, raw)
        VALUES (@id, @chatId, @nativeId, @sender, @text, @ts, @out, @media, @raw)
        ON CONFLICT(id) DO UPDATE SET
          text = excluded.text, sender = excluded.sender,
          media = COALESCE(excluded.media, messages.media), raw = COALESCE(excluded.raw, messages.raw)`),
      getMessage: p(`SELECT m.*, f.path AS local_path FROM messages m LEFT JOIN files f ON f.msg_id = m.id WHERE m.id = ?`),
      page: p(`SELECT m.*, f.path AS local_path FROM messages m LEFT JOIN files f ON f.msg_id = m.id
               WHERE m.chat_id = @chatId AND m.ts < @before ORDER BY m.ts DESC, m.rowid DESC LIMIT @limit`),
      countMessages: p(`SELECT COUNT(*) AS n FROM messages WHERE chat_id = ?`),
      setFile: p(`INSERT INTO files (msg_id, path, size, last_access) VALUES (@msgId, @path, @size, @now)
                  ON CONFLICT(msg_id) DO UPDATE SET path = @path, size = @size, last_access = @now`),
      touchFile: p(`UPDATE files SET last_access = @now WHERE msg_id = @msgId`),
      getFile: p(`SELECT * FROM files WHERE msg_id = ?`),
      fileByPath: p(`SELECT 1 FROM files WHERE path = ?`),
      lruFiles: p(`SELECT * FROM files ORDER BY last_access ASC`),
      totalBytes: p(`SELECT COALESCE(SUM(size), 0) AS n FROM files`),
      deleteFile: p(`DELETE FROM files WHERE msg_id = ?`),
    };
  }

  static chatDto(r) {
    return r && {
      id: r.id, source: r.id.slice(0, 2), title: r.title, isGroup: !!r.is_group, unread: r.unread,
      pinned: !!r.pinned, pinOrder: r.pin_order, lastTs: r.last_ts, lastText: r.last_text, lastOut: !!r.last_out,
    };
  }

  static msgDto(r) {
    return r && {
      id: r.id, chatId: r.chat_id, sender: r.sender, text: r.text, ts: r.ts, out: !!r.out,
      media: r.media ? JSON.parse(r.media) : null, localPath: r.local_path || null,
    };
  }

  upsertChat(c) { this.q.upsertChat.run(nn({ title: null, isGroup: null, unread: null, ...c })); }
  touchLast(id, ts, text, out) { this.q.touchLast.run(nn({ id, ts, text, out: out == null ? null : out ? 1 : 0 })); }
  bumpUnread(id) { this.q.bumpUnread.run({ id }); }
  markRead(id) { this.q.markRead.run({ id }); }
  setPinned(id, pinned) { (pinned ? this.q.pin : this.q.unpin).run({ id }); }
  getChat(id) { return Store.chatDto(this.q.getChat.get(id)); }
  listChats() { return this.q.listChats.all().map(Store.chatDto); }

  // Returns true when the message was not stored before.
  upsertMessage(m) {
    const isNew = !this.q.hasMessage.get(m.id);
    this.q.upsertMessage.run(nn({
      sender: '', text: '', media: null, raw: null, ...m, out: m.out ? 1 : 0,
      media: m.media ? JSON.stringify(m.media) : null,
    }));
    return isNew;
  }
  getMessage(id) { return Store.msgDto(this.q.getMessage.get(id)); }
  getMessageRow(id) { return this.q.getMessage.get(id); }
  page(chatId, before, limit) {
    return this.q.page.all({ chatId, before: before || Number.MAX_SAFE_INTEGER, limit }).reverse().map(Store.msgDto);
  }
  countMessages(chatId) { return this.q.countMessages.get(chatId).n; }

  setFile(msgId, path, size) { this.q.setFile.run({ msgId, path, size, now: Date.now() }); }
  touchFile(msgId) { this.q.touchFile.run({ msgId, now: Date.now() }); }
  getFile(msgId) { return this.q.getFile.get(msgId) || null; }
  isKnownFile(path) { return !!this.q.fileByPath.get(path); }
  lruFiles() { return this.q.lruFiles.all(); }
  totalBytes() { return this.q.totalBytes.get().n; }
  deleteFile(msgId) { this.q.deleteFile.run(msgId); }
}

module.exports = { Store };
