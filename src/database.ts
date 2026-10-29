import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import type { IncomingMessage, Listing } from "./types.js";

export class Store {
  private readonly db: Database.Database;

  constructor(path: string) {
    const absolute = resolve(path);
    mkdirSync(dirname(absolute), { recursive: true });
    this.db = new Database(absolute);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        channel_id TEXT NOT NULL,
        message_id INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        channel TEXT NOT NULL,
        text TEXT NOT NULL,
        link TEXT NOT NULL,
        published_at TEXT NOT NULL,
        edited INTEGER NOT NULL,
        matched INTEGER NOT NULL,
        parsed_json TEXT NOT NULL,
        notified_at TEXT,
        PRIMARY KEY (channel_id, message_id, content_hash)
      );
      CREATE INDEX IF NOT EXISTS idx_messages_matched ON messages(matched, published_at);
    `);
  }

  save(message: IncomingMessage, listing: Listing, matched: boolean): { isNewVersion: boolean; key: string } {
    const hash = createHash("sha256").update(message.text).digest("hex");
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO messages
      (channel_id, message_id, content_hash, channel, text, link, published_at, edited, matched, parsed_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(message.channelId, message.messageId, hash, message.channel, message.text, message.link,
      message.date.toISOString(), Number(message.edited), Number(matched), JSON.stringify(listing));
    return { isNewVersion: result.changes === 1, key: `${message.channelId}:${message.messageId}:${hash}` };
  }

  markNotified(key: string): void {
    const [channelId, messageId, hash] = key.split(":");
    this.db.prepare("UPDATE messages SET notified_at = ? WHERE channel_id = ? AND message_id = ? AND content_hash = ?")
      .run(new Date().toISOString(), channelId, Number(messageId), hash);
  }

  stats(): { processed: number; matched: number; notified: number } {
    return this.db.prepare(`SELECT COUNT(*) processed, SUM(matched) matched,
      SUM(CASE WHEN notified_at IS NOT NULL THEN 1 ELSE 0 END) notified FROM messages`).get() as any;
  }

  close(): void { this.db.close(); }
}
