import { createLogger } from "./logger.js";
import { TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions/index.js";
import { NewMessage, EditedMessage } from "teleproto/events/index.js";
import { loadEnv, loadSearchConfig } from "./config.js";
import { parseListing, matchesSearch } from "./parser.js";
import { Store } from "./database.js";
import { TelegramBot } from "./bot.js";
import { scanHistory } from "./history.js";
import { acquireInstanceLock } from "./lock.js";
import { startSiteMonitor } from "./site-monitor.js";
import { dirname, join } from "node:path";
import type { IncomingMessage } from "./types.js";

const env = loadEnv();
const config = loadSearchConfig();
const log = createLogger(env.LOG_LEVEL);
let releaseLock: () => void;
let stopSites: (() => void) | undefined;
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
bot = new TelegramBot(env.BOT_TOKEN, env.BOT_CHAT_ID,
  async (days) => scanHistory({ client, config, store, bot, days, logger: log }));

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
    const listing = parseListing(text, config);
    const result = matchesSearch(listing, config);
    const saved = store.save(incoming, listing, result.matches);
    if (!saved.isNewVersion) return;
    log.info({ channel, messageId: message.id, matched: result.matches, reasons: result.reasons }, "message processed");
    if (result.matches) {
      await bot.sendListing(incoming, listing);
      store.markNotified(saved.key);
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
  if (env.SITES_INTERVAL_MIN > 0) {
    stopSites = startSiteMonitor({ config, store, bot, logger: log }, env.SITES_INTERVAL_MIN * 60_000);
  }
  log.info({ channels: config.channels }, "Real Estate Radar started");
}

// MTProto can silently stop delivering updates; ping it and reconnect, or exit so a supervisor restarts us.
const HEALTH_INTERVAL_MS = 5 * 60_000;
let healthTimer: NodeJS.Timeout | undefined;
let healthFailures = 0;
function startHealthCheck(): void {
  healthTimer = setInterval(async () => {
    try {
      await Promise.race([client.getMe(), new Promise((_, reject) => setTimeout(() => reject(new Error("getMe timeout")), 30_000))]);
      if (healthFailures > 0) log.info("Telegram connection restored");
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
  stopSites?.();
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
