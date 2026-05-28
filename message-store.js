import Database from "better-sqlite3";

export class MessageStore {
  constructor(dbPath = "./messages.db") {
    this.db = new Database(dbPath);
    this._init();
  }

  _init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        chat_mid TEXT NOT NULL,
        from_mid TEXT,
        to_mid TEXT,
        text TEXT,
        content_type TEXT,
        content_metadata TEXT,
        location TEXT,
        created_time INTEGER NOT NULL,
        related_message_id TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_messages_chat_time
        ON messages(chat_mid, created_time DESC, id DESC);
    `);
  }

  save(chatMid, msg) {
    this.db.prepare(`
      INSERT OR REPLACE INTO messages
        (id, chat_mid, from_mid, to_mid, text, content_type, content_metadata, location, created_time, related_message_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      String(msg.id),
      String(chatMid),
      msg.from ? String(msg.from) : null,
      msg.to ? String(msg.to) : null,
      msg.text || null,
      msg.contentType != null ? String(msg.contentType) : null,
      JSON.stringify(msg.contentMetadata || {}),
      msg.location ? JSON.stringify(msg.location) : null,
      Number(msg.createdTime),
      msg.relatedMessageId ? String(msg.relatedMessageId) : null,
    );
  }

  saveBatch(chatMid, msgs) {
    const run = this.db.transaction(() => {
      for (const msg of msgs) {
        this.save(chatMid, msg);
      }
    });
    run();
  }

  // DBに保存済みのメッセージを取得する。
  // beforeCreatedTime/beforeId を指定するとそれより古いメッセージを返す（ページネーション）。
  getMessages(chatMid, { limit = 100, beforeCreatedTime = null, beforeId = null } = {}) {
    let query = "SELECT * FROM messages WHERE chat_mid = ?";
    const params = [chatMid];

    if (beforeCreatedTime != null) {
      query += " AND (created_time < ? OR (created_time = ? AND CAST(id AS INTEGER) < CAST(? AS INTEGER)))";
      params.push(beforeCreatedTime, beforeCreatedTime, beforeId ?? "0");
    }

    query += " ORDER BY created_time DESC, id DESC LIMIT ?";
    params.push(limit + 1);

    const rows = this.db.prepare(query).all(...params);
    const hasMore = rows.length > limit;
    const messages = rows.slice(0, limit).reverse().map(rowToMessage);
    return { messages, hasMore };
  }

  markAsUnsent(messageId) {
    this.db.prepare(
      "UPDATE messages SET text = NULL, content_metadata = ? WHERE id = ?",
    ).run(JSON.stringify({ UNSENT: "true" }), String(messageId));
  }

  hasMessages(chatMid) {
    return !!this.db.prepare("SELECT 1 FROM messages WHERE chat_mid = ? LIMIT 1").get(chatMid);
  }

  getLatestCreatedTime(chatMid) {
    const row = this.db.prepare(
      "SELECT created_time FROM messages WHERE chat_mid = ? ORDER BY created_time DESC LIMIT 1",
    ).get(chatMid);
    return row ? row.created_time : 0;
  }
}

function rowToMessage(row) {
  return {
    id: row.id,
    from: row.from_mid || "",
    to: row.to_mid || "",
    text: row.text || "",
    contentType: row.content_type || "NONE",
    contentMetadata: JSON.parse(row.content_metadata || "{}"),
    location: row.location ? JSON.parse(row.location) : null,
    createdTime: row.created_time,
    relatedMessageId: row.related_message_id || undefined,
  };
}
