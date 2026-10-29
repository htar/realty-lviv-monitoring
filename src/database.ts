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
      CREATE TABLE IF NOT EXISTS sent_fingerprints (
        fingerprint TEXT PRIMARY KEY,
        sent_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS favorites (
        channel_id TEXT NOT NULL,
        message_id INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (channel_id, message_id)
      );
      CREATE TABLE IF NOT EXISTS feedback (
        channel_id TEXT NOT NULL,
        message_id INTEGER NOT NULL,
        verdict TEXT NOT NULL CHECK(verdict IN ('good', 'bad')),
        created_at TEXT NOT NULL,
        PRIMARY KEY (channel_id, message_id)
      );
      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        action TEXT NOT NULL,
        details TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    const columns = this.db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "reasons_json")) {
      this.db.exec("ALTER TABLE messages ADD COLUMN reasons_json TEXT");
    }
    if (!columns.some((column) => column.name === "retry_count")) {
      this.db.exec("ALTER TABLE messages ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0");
    }
    if (!columns.some((column) => column.name === "next_attempt_at")) {
      this.db.exec("ALTER TABLE messages ADD COLUMN next_attempt_at TEXT");
    }
    if (!columns.some((column) => column.name === "last_delivery_error")) {
      this.db.exec("ALTER TABLE messages ADD COLUMN last_delivery_error TEXT");
    }
  }

  save(message: IncomingMessage, listing: Listing, matched: boolean, reasons: string[] = []): { isNewVersion: boolean; key: string } {
    const hash = createHash("sha256").update(message.text).digest("hex");
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO messages
      (channel_id, message_id, content_hash, channel, text, link, published_at, edited, matched, parsed_json, reasons_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(message.channelId, message.messageId, hash, message.channel, message.text, message.link,
      message.date.toISOString(), Number(message.edited), Number(matched), JSON.stringify(listing), JSON.stringify(reasons));
    return { isNewVersion: result.changes === 1, key: `${message.channelId}:${message.messageId}:${hash}` };
  }

  hasVersion(message: IncomingMessage): boolean {
    const hash = createHash("sha256").update(message.text).digest("hex");
    return Boolean(this.db.prepare(`SELECT 1 FROM messages WHERE channel_id = ? AND message_id = ? AND content_hash = ?`)
      .get(message.channelId, message.messageId, hash));
  }

  /** UAH price of the most recent earlier version of the same post, if it had one. */
  previousPrice(channelId: string, messageId: number, currentKey: string): number | undefined {
    const hash = currentKey.split(":")[2];
    const rows = this.db.prepare(`SELECT parsed_json FROM messages WHERE channel_id = ? AND message_id = ? AND content_hash != ?
      ORDER BY rowid DESC LIMIT 1`).all(channelId, messageId, hash) as Array<{ parsed_json: string }>;
    try { return rows[0] ? (JSON.parse(rows[0].parsed_json) as Listing).priceUah : undefined; }
    catch { return undefined; }
  }

  /** True when the same listing (by fingerprint) was already sent within the window. */
  wasSentRecently(fingerprint: string, days = 7, now = new Date()): boolean {
    const since = new Date(now.getTime() - days * 86_400_000).toISOString();
    return Boolean(this.db.prepare("SELECT 1 FROM sent_fingerprints WHERE fingerprint = ? AND sent_at >= ?").get(fingerprint, since));
  }

  rememberSent(fingerprint: string, now = new Date()): void {
    this.db.prepare(`INSERT INTO sent_fingerprints (fingerprint, sent_at) VALUES (?, ?)
      ON CONFLICT(fingerprint) DO UPDATE SET sent_at = excluded.sent_at`).run(fingerprint, now.toISOString());
  }

  addFavorite(channelId: string, messageId: number): boolean {
    return this.db.prepare("INSERT OR IGNORE INTO favorites (channel_id, message_id, created_at) VALUES (?, ?, ?)")
      .run(channelId, messageId, new Date().toISOString()).changes === 1;
  }

  removeFavorite(channelId: string, messageId: number): boolean {
    return this.db.prepare("DELETE FROM favorites WHERE channel_id = ? AND message_id = ?").run(channelId, messageId).changes === 1;
  }

  recordFeedback(channelId: string, messageId: number, verdict: "good" | "bad"): void {
    this.db.prepare(`INSERT INTO feedback (channel_id, message_id, verdict, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(channel_id, message_id) DO UPDATE SET verdict = excluded.verdict, created_at = excluded.created_at`)
      .run(channelId, messageId, verdict, new Date().toISOString());
  }

  feedbackStats(): { good: number; bad: number } {
    const row = this.db.prepare(`SELECT SUM(verdict = 'good') good, SUM(verdict = 'bad') bad FROM feedback`).get() as any;
    return { good: row.good ?? 0, bad: row.bad ?? 0 };
  }

  audit(action: string, details: string): void {
    this.db.prepare("INSERT INTO audit_log (action, details, created_at) VALUES (?, ?, ?)")
      .run(action, details, new Date().toISOString());
  }

  favorites(limit = 30): Array<{ channelId: string; messageId: number; link: string; listing: Listing }> {
    const rows = this.db.prepare(`SELECT f.channel_id, f.message_id,
        (SELECT link FROM messages m WHERE m.channel_id = f.channel_id AND m.message_id = f.message_id ORDER BY rowid DESC LIMIT 1) link,
        (SELECT parsed_json FROM messages m WHERE m.channel_id = f.channel_id AND m.message_id = f.message_id ORDER BY rowid DESC LIMIT 1) parsed_json
      FROM favorites f ORDER BY f.created_at DESC LIMIT ?`).all(limit) as Array<any>;
    return rows.filter((row) => row.link).map((row) => ({ channelId: row.channel_id, messageId: row.message_id,
      link: row.link, listing: JSON.parse(row.parsed_json) as Listing }));
  }

  /** Most common rejection reasons since the given date. */
  topReasons(since: Date, limit = 10): Array<{ reason: string; count: number }> {
    return this.db.prepare(`SELECT j.value reason, COUNT(*) count FROM messages, json_each(messages.reasons_json) j
      WHERE messages.reasons_json IS NOT NULL AND published_at >= ? GROUP BY j.value ORDER BY count DESC LIMIT ?`)
      .all(since.toISOString(), limit) as Array<{ reason: string; count: number }>;
  }

  /** Activity summary since the given date, for the daily digest. */
  summarySince(since: Date): { processed: number; matched: number; notified: number; avgMatchedPrice?: number } {
    const row = this.db.prepare(`SELECT COUNT(*) processed, COALESCE(SUM(matched), 0) matched,
        SUM(CASE WHEN notified_at IS NOT NULL THEN 1 ELSE 0 END) notified,
        AVG(CASE WHEN matched = 1 THEN json_extract(parsed_json, '$.priceUah') END) avg
      FROM messages WHERE published_at >= ?`).get(since.toISOString()) as any;
    return { processed: row.processed, matched: row.matched, notified: row.notified ?? 0,
      ...(row.avg ? { avgMatchedPrice: Math.round(row.avg) } : {}) };
  }

  getSetting(key: string): string | undefined {
    return (this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined)?.value;
  }

  setSetting(key: string, value: string): void {
    this.db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .run(key, value, new Date().toISOString());
  }

  /** Writes a consistent copy of the database to the given file. */
  async backup(destination: string): Promise<void> {
    mkdirSync(dirname(resolve(destination)), { recursive: true });
    await this.db.backup(resolve(destination));
  }

  integrityCheck(): boolean {
    return (this.db.pragma("integrity_check", { simple: true }) as string) === "ok";
  }

  markNotified(key: string): void {
    const [channelId, messageId, hash] = key.split(":");
    this.db.prepare("UPDATE messages SET notified_at = ? WHERE channel_id = ? AND message_id = ? AND content_hash = ?")
      .run(new Date().toISOString(), channelId, Number(messageId), hash);
    this.db.prepare(`UPDATE messages SET retry_count = 0, next_attempt_at = NULL, last_delivery_error = NULL
      WHERE channel_id = ? AND message_id = ? AND content_hash = ?`).run(channelId, Number(messageId), hash);
  }

  markDeliveryFailed(key: string, error: unknown, now = new Date()): void {
    const [channelId, messageId, hash] = key.split(":");
    const row = this.db.prepare(`SELECT retry_count FROM messages WHERE channel_id = ? AND message_id = ? AND content_hash = ?`)
      .get(channelId, Number(messageId), hash) as { retry_count: number } | undefined;
    const retry = (row?.retry_count ?? 0) + 1;
    const delays = [10_000, 60_000, 300_000, 1_800_000];
    const next = new Date(now.getTime() + delays[Math.min(retry - 1, delays.length - 1)]!).toISOString();
    this.db.prepare(`UPDATE messages SET retry_count = ?, next_attempt_at = ?, last_delivery_error = ?
      WHERE channel_id = ? AND message_id = ? AND content_hash = ?`)
      .run(retry, next, error instanceof Error ? error.message : String(error), channelId, Number(messageId), hash);
  }

  pendingNotifications(limit = 500): Array<{ key: string; message: IncomingMessage; listing: Listing }> {
    const rows = this.db.prepare(`SELECT channel_id, message_id, content_hash, channel, text, link,
      published_at, edited, parsed_json FROM messages
      WHERE matched = 1 AND notified_at IS NULL AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
      ORDER BY published_at ASC LIMIT ?`).all(new Date().toISOString(), limit) as Array<any>;
    const pending: Array<{ key: string; message: IncomingMessage; listing: Listing }> = [];
    for (const row of rows) {
      try {
        pending.push({
          key: `${row.channel_id}:${row.message_id}:${row.content_hash}`,
          message: { channel: row.channel, channelId: row.channel_id, messageId: row.message_id,
            text: row.text, link: row.link, date: new Date(row.published_at), edited: Boolean(row.edited) },
          listing: JSON.parse(row.parsed_json) as Listing
        });
      } catch { /* Skip corrupt legacy rows; keep them visible for manual inspection. */ }
    }
    return pending;
  }

  stats(): { processed: number; matched: number; notified: number } {
    return this.db.prepare(`SELECT COUNT(*) processed, SUM(matched) matched,
      SUM(CASE WHEN notified_at IS NOT NULL THEN 1 ELSE 0 END) notified FROM messages`).get() as any;
  }

  deliveryStats(): { pending: number; delayed: number; lastMessageAt?: string; lastNotifiedAt?: string } {
    const row = this.db.prepare(`SELECT
      SUM(matched = 1 AND notified_at IS NULL) pending,
      SUM(matched = 1 AND notified_at IS NULL AND next_attempt_at > ?) delayed,
      MAX(published_at) last_message_at, MAX(notified_at) last_notified_at FROM messages`)
      .get(new Date().toISOString()) as any;
    return { pending: row.pending ?? 0, delayed: row.delayed ?? 0,
      ...(row.last_message_at ? { lastMessageAt: row.last_message_at } : {}),
      ...(row.last_notified_at ? { lastNotifiedAt: row.last_notified_at } : {}) };
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
