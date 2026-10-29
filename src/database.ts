import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import type { IncomingMessage, Listing, SearchConfig } from "./types.js";

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
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
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

  loadFilters(): SearchConfig["filters"] | undefined {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'filters'").get() as { value: string } | undefined;
    if (!row) return undefined;
    try { return JSON.parse(row.value) as SearchConfig["filters"]; }
    catch { return undefined; }
  }

  saveFilters(filters: SearchConfig["filters"]): void {
    this.db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('filters', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .run(JSON.stringify(filters), new Date().toISOString());
  }

  loadChannels(): string[] | undefined {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'channels'").get() as { value: string } | undefined;
    if (!row) return undefined;
    try {
      const value = JSON.parse(row.value);
      return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
    } catch { return undefined; }
  }

  saveChannels(channels: string[]): void {
    this.db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('channels', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .run(JSON.stringify(channels), new Date().toISOString());
  }

  close(): void { this.db.close(); }
}
