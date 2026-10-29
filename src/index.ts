import pino from "pino";
import { TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions/index.js";
import { NewMessage, EditedMessage } from "teleproto/events/index.js";
import { loadEnv, loadSearchConfig } from "./config.js";
import { parseListing, matchesSearch } from "./parser.js";
import { Store } from "./database.js";
import { TelegramBot } from "./bot.js";
import type { IncomingMessage } from "./types.js";

const env = loadEnv();
const config = loadSearchConfig();
const log = pino({ level: env.LOG_LEVEL });
const store = new Store(env.DATABASE_PATH);
const savedFilters = store.loadFilters();
if (savedFilters) config.filters = { ...config.filters, ...savedFilters };
const savedChannels = store.loadChannels();
if (savedChannels) config.channels = savedChannels;
const bot = new TelegramBot(env.BOT_TOKEN, env.BOT_CHAT_ID);
const client = new TelegramClient(new StringSession(env.TG_SESSION), env.TG_API_ID, env.TG_API_HASH, {
  connectionRetries: 10, autoReconnect: true
});

async function handle(event: any, edited: boolean): Promise<void> {
  try {
    const message = event.message;
    const text = message?.message?.trim();
    if (!text) return;
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
  log.info({ channels: config.channels }, "Real Estate Radar started");
}

async function shutdown(signal: string): Promise<void> {
  log.info({ signal }, "shutting down");
  bot.stop();
  await client.disconnect();
  store.close();
  process.exit(0);
}
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
main().catch((error) => { log.fatal({ err: error }, "startup failed"); process.exit(1); });
