import type { TelegramClient } from "teleproto";
import type { Logger } from "pino";
import type { SearchConfig, IncomingMessage } from "./types.js";
import type { Store } from "./database.js";
import type { TelegramBot } from "./bot.js";
import { parseListing, matchesSearch } from "./parser.js";
import { DEFAULT_TIME_ZONE, dateInTimeZone, zonedMidnight, addCalendarDays } from "./time.js";

export interface HistoryScanSummary {
  firstDay: string;
  lastDay: string;
  timeZone: string;
  scanned: number;
  newVersions: number;
  matched: number;
  notified: number;
  retriedPending: number;
  failedChannels: number;
}

export async function scanHistory(options: {
  client: TelegramClient;
  config: SearchConfig;
  store: Store;
  bot: TelegramBot;
  days: number;
  logger?: Logger;
  now?: Date;
}): Promise<HistoryScanSummary> {
  const { client, config, store, bot, days, logger, now = new Date() } = options;
  if (!Number.isInteger(days) || days < 1 || days > 30) throw new Error("Кількість днів має бути від 1 до 30");
  const today = dateInTimeZone(now, DEFAULT_TIME_ZONE);
  const firstDay = addCalendarDays(today, -(days - 1));
  const nextDay = addCalendarDays(today, 1);
  const from = zonedMidnight(firstDay, DEFAULT_TIME_ZONE);
  const to = zonedMidnight(nextDay, DEFAULT_TIME_ZONE);
  const summary: HistoryScanSummary = { firstDay, lastDay: today, timeZone: DEFAULT_TIME_ZONE,
    scanned: 0, newVersions: 0, matched: 0, notified: 0, retriedPending: 0, failedChannels: 0 };

  for (const channel of config.channels) {
    let channelScanned = 0;
    let channelMatched = 0;
    try {
      for await (const telegramMessage of client.iterMessages(`@${channel}`, {
        limit: 1000, offsetDate: Math.floor(to.getTime() / 1000), waitTime: 1
      })) {
        const date = new Date(Number(telegramMessage.date) * 1000);
        if (date < from) break;
        if (date >= to) continue;
        const text = telegramMessage.message?.trim();
        if (!text) continue;
        summary.scanned += 1;
        channelScanned += 1;
        const incoming: IncomingMessage = { channel, channelId: String(telegramMessage.chatId ?? channel),
          messageId: Number(telegramMessage.id), text, date, link: `https://t.me/${channel}/${telegramMessage.id}`,
          edited: Boolean(telegramMessage.editDate) };
        const listing = parseListing(text, config);
        const result = matchesSearch(listing, config);
        const saved = store.save(incoming, listing, result.matches);
        if (!saved.isNewVersion) continue;
        summary.newVersions += 1;
        if (!result.matches) continue;
        summary.matched += 1;
        channelMatched += 1;
      }
      logger?.info({ channel, scanned: channelScanned, matched: channelMatched }, "channel scan completed");
    } catch (error) {
      summary.failedChannels += 1;
      logger?.warn({ channel, err: error }, "channel scan failed");
    }
  }

  for (const pending of store.pendingNotifications()) {
    await bot.sendListing(pending.message, pending.listing);
    store.markNotified(pending.key);
    summary.notified += 1;
    summary.retriedPending += 1;
  }
  return summary;
}
