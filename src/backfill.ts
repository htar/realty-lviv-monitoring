import pino from "pino";
import { TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions/index.js";
import { loadEnv, loadSearchConfig } from "./config.js";
import { parseListing, matchesSearch } from "./parser.js";
import { Store } from "./database.js";
import { TelegramBot } from "./bot.js";
import type { IncomingMessage } from "./types.js";

const TIME_ZONE = "Europe/Kyiv";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function dateInTimeZone(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit"
  }).format(date);
}

function zonedMidnight(dateText: string): Date {
  const [year, month, day] = dateText.split("-").map(Number);
  if (!year || !month || !day) throw new Error(`Некоректна дата: ${dateText}`);
  const desired = Date.UTC(year, month - 1, day);
  let utc = desired;
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
  });
  for (let i = 0; i < 2; i += 1) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(utc)).map((part) => [part.type, part.value]));
    const represented = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day),
      Number(parts.hour), Number(parts.minute), Number(parts.second));
    utc += desired - represented;
  }
  return new Date(utc);
}

function addCalendarDays(dateText: string, days: number): string {
  const [year, month, day] = dateText.split("-").map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day! + days));
  return date.toISOString().slice(0, 10);
}

const days = Number(argument("--days") ?? "2");
if (!Number.isInteger(days) || days < 1 || days > 30) {
  throw new Error("--days має бути цілим числом від 1 до 30");
}

const env = loadEnv();
const config = loadSearchConfig();
const log = pino({ level: env.LOG_LEVEL });
const store = new Store(env.DATABASE_PATH);
const savedFilters = store.loadFilters();
if (savedFilters) config.filters = { ...config.filters, ...savedFilters };
const savedChannels = store.loadChannels();
if (savedChannels) config.channels = savedChannels;

const today = dateInTimeZone(new Date());
const firstDay = addCalendarDays(today, -(days - 1));
const nextDay = addCalendarDays(today, 1);
const from = zonedMidnight(firstDay);
const to = zonedMidnight(nextDay);

const bot = new TelegramBot(env.BOT_TOKEN, env.BOT_CHAT_ID);
const client = new TelegramClient(new StringSession(env.TG_SESSION), env.TG_API_ID, env.TG_API_HASH, {
  connectionRetries: 10, autoReconnect: true
});

let scanned = 0;
let newVersions = 0;
let matched = 0;
let notified = 0;
let failedChannels = 0;

try {
  await client.connect();
  if (!await client.checkAuthorization()) throw new Error("TG_SESSION не авторизована");
  log.info({ firstDay, today, channels: config.channels.length }, "historical scan started");

  for (const channel of config.channels) {
    let channelScanned = 0;
    let channelMatched = 0;
    try {
      for await (const message of client.iterMessages(`@${channel}`, {
        limit: 1000,
        offsetDate: Math.floor(to.getTime() / 1000),
        waitTime: 1
      })) {
        const date = new Date(Number(message.date) * 1000);
        if (date < from) break;
        if (date >= to) continue;
        const text = message.message?.trim();
        if (!text) continue;

        scanned += 1;
        channelScanned += 1;
        const incoming: IncomingMessage = {
          channel,
          channelId: String(message.chatId ?? channel),
          messageId: Number(message.id),
          text,
          date,
          link: `https://t.me/${channel}/${message.id}`,
          edited: Boolean(message.editDate)
        };
        const listing = parseListing(text, config);
        const result = matchesSearch(listing, config);
        const saved = store.save(incoming, listing, result.matches);
        if (!saved.isNewVersion) continue;
        newVersions += 1;
        if (!result.matches) continue;
        matched += 1;
        channelMatched += 1;
        await bot.sendListing(incoming, listing);
        store.markNotified(saved.key);
        notified += 1;
      }
      log.info({ channel, scanned: channelScanned, matched: channelMatched }, "channel scan completed");
    } catch (error) {
      failedChannels += 1;
      log.warn({ channel, err: error }, "channel scan failed");
    }
  }
} finally {
  await client.disconnect();
  store.close();
}

console.log(JSON.stringify({ range: { firstDay, lastDay: today, timeZone: TIME_ZONE }, scanned,
  newVersions, matched, notified, failedChannels }, null, 2));
