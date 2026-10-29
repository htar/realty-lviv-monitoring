import { createLogger } from "./logger.js";
import { TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions/index.js";
import { loadEnv, loadSearchConfig } from "./config.js";
import { Store } from "./database.js";
import { TelegramBot } from "./bot.js";
import { scanHistory } from "./history.js";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const days = Number(argument("--days") ?? "2");
const env = loadEnv();
const config = loadSearchConfig();
const log = createLogger(env.LOG_LEVEL);
const store = new Store(env.DATABASE_PATH);
const savedFilters = store.loadFilters();
if (savedFilters) config.filters = { ...config.filters, ...savedFilters };
const savedChannels = store.loadChannels();
if (savedChannels) config.channels = savedChannels;
const bot = new TelegramBot(env.BOT_TOKEN, env.BOT_CHAT_ID);
const client = new TelegramClient(new StringSession(env.TG_SESSION), env.TG_API_ID, env.TG_API_HASH, {
  connectionRetries: 10, autoReconnect: true
});

try {
  await client.connect();
  if (!await client.checkAuthorization()) throw new Error("TG_SESSION не авторизована");
  log.info({ days, channels: config.channels.length }, "historical scan started");
  const summary = await scanHistory({ client, config, store, bot, days, logger: log });
  console.log(JSON.stringify({ range: { firstDay: summary.firstDay, lastDay: summary.lastDay,
    timeZone: summary.timeZone }, ...summary }, null, 2));
} finally {
  await client.disconnect();
  store.close();
}
