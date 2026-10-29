import { createLogger } from "./logger.js";
import { TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions/index.js";
import { NewMessage, EditedMessage } from "teleproto/events/index.js";
import { loadEnv, loadSearchConfig } from "./config.js";
import { parseListing, matchesSearch } from "./parser.js";
import { Store } from "./database.js";
import { TelegramBot } from "./bot.js";
import { flushPendingNotifications, scanHistory } from "./history.js";
import { acquireInstanceLock } from "./lock.js";
import { startSiteMonitor } from "./site-monitor.js";
import { deliverListing } from "./notify.js";
import { startScheduler } from "./scheduler.js";
import { dirname, join } from "node:path";
import type { IncomingMessage } from "./types.js";

const env = loadEnv();
const config = loadSearchConfig();
const log = createLogger(env.LOG_LEVEL);
let releaseLock: () => void;
let stopSites: (() => void) | undefined;
const startedAt = new Date();
let lastUpdateAt: Date | undefined;
let lastRecoveryAt: Date | undefined;
let recoveryRunning: Promise<ReturnType<typeof scanHistory> extends Promise<infer T> ? T : never> | undefined;
let recoveryTimer: NodeJS.Timeout | undefined;
let queueTimer: NodeJS.Timeout | undefined;
let flushRunning = false;
try {
  releaseLock = acquireInstanceLock(join(dirname(env.DATABASE_PATH), "radar.lock"));
} catch (error) {
  log.fatal((error as Error).message);
  process.exit(1);
}
const store = new Store(env.DATABASE_PATH);
const savedFilters = store.loadFilters();
if (savedFilters) config.filters = { ...config.filters, ...savedFilters };
const savedChannels = store.loadChannels();
if (savedChannels) config.channels = savedChannels;
const client = new TelegramClient(new StringSession(env.TG_SESSION), env.TG_API_ID, env.TG_API_HASH, {
  connectionRetries: 10, autoReconnect: true
});
let bot: TelegramBot;
const recover = (days: number, deliver = true) => {
  if (recoveryRunning) return recoveryRunning;
  recoveryRunning = scanHistory({ client, config, store, bot, days, logger: log, deliver })
    .finally(() => { recoveryRunning = undefined; });
  return recoveryRunning;
};
bot = new TelegramBot(env.BOT_TOKEN, env.BOT_CHAT_ID,
  async (days) => recover(days, true), 3000,
  async (days) => recover(days, false),
  () => ({ startedAt, telegramConnected: healthFailures === 0, lastUpdateAt, lastRecoveryAt, healthFailures }));

async function handle(event: any, edited: boolean): Promise<void> {
  try {
    const message = event.message;
    const text = message?.message?.trim();
    if (!text) return;
    // Skip private chats and groups before the network call to getChat().
    if (message.peerId?.className !== "PeerChannel") return;
    const chat = await message.getChat();
    const channel = String(chat?.username ?? "").replace(/^@/, "");
    if (!channel || !config.channels.some((item) => item.toLowerCase() === channel.toLowerCase())) return;
    const channelId = String(message.chatId ?? chat?.id ?? channel);
    const incoming: IncomingMessage = {
      channel, channelId, messageId: Number(message.id), text,
      date: new Date(Number(message.date) * 1000),
      link: `https://t.me/${channel}/${message.id}`, edited
    };
    lastUpdateAt = new Date();
    store.setSetting(`checkpoint:${channel.toLowerCase()}`, JSON.stringify({ messageId: incoming.messageId, date: incoming.date.toISOString() }));
    const listing = parseListing(text, config);
    const result = matchesSearch(listing, config);
    const saved = store.save(incoming, listing, result.matches, result.reasons);
    if (!saved.isNewVersion) return;
    log.info({ channel, messageId: message.id, matched: result.matches, reasons: result.reasons }, "message processed");
    if (result.matches) {
      try {
        const delivery = await deliverListing({ store, bot, message: incoming, listing, key: saved.key });
        if (delivery === "duplicate") log.info({ channel, messageId: message.id }, "duplicate of a recently sent listing, skipped");
      } catch (error) {
        store.markDeliveryFailed(saved.key, error);
        throw error;
      }
    }
  } catch (error) {
    log.error({ err: error }, "message processing failed");
  }
}

async function main(): Promise<void> {
  await client.connect();
  if (!await client.checkAuthorization()) throw new Error("TG_SESSION не авторизована. Запустіть npm run session.");
  client.addEventHandler((event) => void handle(event, false), new NewMessage({}));
  client.addEventHandler((event) => void handle(event, true), new EditedMessage({}));
  void bot.runCommands(store, config);
  startHealthCheck();
  const previousHeartbeat = store.getSetting("heartbeat_at");
  store.setSetting("heartbeat_at", new Date().toISOString());
  void recover(env.AUTO_RESCAN_DAYS).then(async (summary) => {
    lastRecoveryAt = new Date();
    store.setSetting("last_recovery_at", lastRecoveryAt.toISOString());
    if (previousHeartbeat) {
      const minutes = Math.max(0, Math.round((startedAt.getTime() - new Date(previousHeartbeat).getTime()) / 60_000));
      await bot.sendText(`✅ Монітор запущено після перерви приблизно ${minutes} хв. Перевірено ${summary.scanned}, доставлено ${summary.notified}, помилок каналів ${summary.failedChannels}.`)
        .catch((error) => log.warn({ err: error }, "startup recovery report failed"));
    }
  }).catch((error) => log.error({ err: error }, "startup recovery failed"));
  if (env.RESCAN_INTERVAL_HOURS > 0) recoveryTimer = setInterval(() => {
    void recover(env.AUTO_RESCAN_DAYS).then((summary) => {
      lastRecoveryAt = new Date();
      store.setSetting("last_recovery_at", lastRecoveryAt.toISOString());
      if (summary.notified || summary.failedChannels || summary.failedNotifications) {
        void bot.sendText(`🔄 Контрольна перевірка: доставлено ${summary.notified}, помилок каналів ${summary.failedChannels}, помилок доставки ${summary.failedNotifications}.`);
      }
    }).catch((error) => log.warn({ err: error }, "scheduled recovery failed"));
  }, env.RESCAN_INTERVAL_HOURS * 3_600_000);
  queueTimer = setInterval(() => {
    if (recoveryRunning || flushRunning) return;
    flushRunning = true;
    void flushPendingNotifications({ store, bot, logger: log, protectFreshSeconds: 60 }).then((result) => {
      if (result.notified) log.info(result, "pending delivery queue flushed");
    }).catch((error) => log.warn({ err: error }, "pending delivery queue failed"))
      .finally(() => { flushRunning = false; });
  }, 10_000);
  if (env.SITES_INTERVAL_MIN > 0) {
    stopSites = startSiteMonitor({ config, store, bot, logger: log }, env.SITES_INTERVAL_MIN * 60_000);
  }
  stopScheduler = startScheduler({ store, send: (text) => bot.sendText(text), logger: log,
    backupDir: join(dirname(env.DATABASE_PATH), "backups") });
  log.info({ channels: config.channels }, "Real Estate Radar started");
}

// MTProto can silently stop delivering updates; ping it and reconnect, or exit so a supervisor restarts us.
const HEALTH_INTERVAL_MS = 5 * 60_000;
const HEARTBEAT_INTERVAL_MS = 60_000;
let healthTimer: NodeJS.Timeout | undefined;
let heartbeatTimer: NodeJS.Timeout | undefined;
let healthFailures = 0;
let stopScheduler: (() => void) | undefined;
function startHealthCheck(): void {
  heartbeatTimer = setInterval(() => store.setSetting("heartbeat_at", new Date().toISOString()), HEARTBEAT_INTERVAL_MS);
  healthTimer = setInterval(async () => {
    try {
      await Promise.race([client.getMe(), new Promise((_, reject) => setTimeout(() => reject(new Error("getMe timeout")), 30_000))]);
      if (healthFailures > 0) {
        log.info("Telegram connection restored");
        void bot.sendText(`✅ Telegram-з'єднання відновлено після ${healthFailures} невдалих health-check.`)
          .catch((sendError) => log.warn({ err: sendError }, "recovery notification failed"));
      }
      healthFailures = 0;
    } catch (error) {
      healthFailures += 1;
      log.warn({ err: error, failures: healthFailures }, "Telegram health check failed, reconnecting");
      if (healthFailures >= 3) { log.fatal("Telegram connection lost, exiting for restart"); await shutdown("healthcheck", 1); return; }
      try { await client.disconnect(); await client.connect(); } catch (reconnectError) { log.warn({ err: reconnectError }, "reconnect failed"); }
    }
  }, HEALTH_INTERVAL_MS);
}

async function shutdown(signal: string, code = 0): Promise<void> {
  log.info({ signal }, "shutting down");
  if (healthTimer) clearInterval(healthTimer);
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (recoveryTimer) clearInterval(recoveryTimer);
  if (queueTimer) clearInterval(queueTimer);
  stopSites?.();
  stopScheduler?.();
  bot.stop();
  await client.disconnect();
  store.close();
  releaseLock();
  process.exit(code);
}
process.on("uncaughtException", (error) => { log.fatal({ err: error }, "uncaught exception"); process.exit(1); });
process.on("unhandledRejection", (reason) => { log.error({ err: reason }, "unhandled rejection"); });
process.on("exit", (code) => { log.info({ code }, "process exit"); });
process.once("SIGHUP", () => void shutdown("SIGHUP"));
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
main().catch((error) => { log.fatal({ err: error }, "startup failed"); process.exit(1); });
