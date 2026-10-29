import { readdirSync, rmSync } from "node:fs";
import Database from "better-sqlite3";
import { join } from "node:path";
import type { Logger } from "pino";
import type { Store } from "./database.js";
import { refreshRates } from "./rates.js";
import { DEFAULT_TIME_ZONE, dateInTimeZone, zonedMidnight } from "./time.js";

export const DIGEST_HOUR = 21;
const RATES_EVERY_MS = 6 * 3_600_000;
const KEEP_BACKUPS = 7;

function hourInKyiv(now: Date): number {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: DEFAULT_TIME_ZONE, hour: "2-digit", hourCycle: "h23" }).format(now));
}

export interface SchedulerDeps {
  store: Store;
  send: (text: string) => Promise<void>;
  backupDir: string;
  logger?: Logger;
  fetchRates?: () => Promise<boolean>;
}

export function digestText(store: Store, day: string): string {
  const s = store.summarySince(zonedMidnight(day));
  const reasons = store.topReasons(zonedMidnight(day), 3);
  return [`🗓 <b>Підсумок за ${day}</b>`,
    `Переглянуто: ${s.processed}`, `Збігів: ${s.matched}`, `Надіслано: ${s.notified}`,
    ...(s.avgMatchedPrice ? [`Середня ціна збігів: ${s.avgMatchedPrice.toLocaleString("uk-UA")} грн`] : []),
    ...(reasons.length ? ["", "Найчастіше відхилялись:", ...reasons.map((r) => `• ${r.reason} (${r.count})`)] : [])
  ].join("\n");
}

/** Keeps only the newest backups. */
export function pruneBackups(dir: string, keep = KEEP_BACKUPS): void {
  const files = readdirSync(dir).filter((name) => /^realty-\d{4}-\d{2}-\d{2}\.sqlite$/.test(name)).sort();
  for (const name of files.slice(0, Math.max(0, files.length - keep))) rmSync(join(dir, name));
}

export function verifyBackup(path: string): boolean {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try { return db.pragma("integrity_check", { simple: true }) === "ok"; }
  finally {
    db.close();
    // SQLite may create empty WAL sidecars while opening a WAL-mode backup.
    rmSync(`${path}-shm`, { force: true });
    rmSync(`${path}-wal`, { force: true });
  }
}

/** One scheduler pass; safe to call often, each job runs at most once per day (or per rate period). */
export async function runScheduledJobs(deps: SchedulerDeps, now = new Date()): Promise<void> {
  const { store, logger } = deps;
  const day = dateInTimeZone(now);

  const ratesAt = Number(store.getSetting("rates_at") ?? 0);
  if (now.getTime() - ratesAt >= RATES_EVERY_MS) {
    const ok = await (deps.fetchRates ?? refreshRates)();
    if (ok) store.setSetting("rates_at", String(now.getTime()));
    else logger?.warn("NBU exchange rates refresh failed, using previous rates");
  }

  if (store.getSetting("backup_date") !== day) {
    try {
      const backupPath = join(deps.backupDir, `realty-${day}.sqlite`);
      await store.backup(backupPath);
      if (!verifyBackup(backupPath)) throw new Error("backup integrity_check failed");
      pruneBackups(deps.backupDir);
      store.setSetting("backup_date", day);
      logger?.info({ day }, "database backup created");
    } catch (error) {
      logger?.warn({ err: error }, "database backup failed");
    }
  }

  if (hourInKyiv(now) >= DIGEST_HOUR && store.getSetting("digest_date") !== day) {
    try {
      await deps.send(digestText(store, day));
      store.setSetting("digest_date", day);
    } catch (error) {
      logger?.warn({ err: error }, "daily digest failed");
    }
  }
}

export function startScheduler(deps: SchedulerDeps, everyMs = 60_000): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await runScheduledJobs(deps); } finally { running = false; }
  };
  void tick();
  const timer = setInterval(() => void tick(), everyMs);
  return () => clearInterval(timer);
}
