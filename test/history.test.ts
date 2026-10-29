import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { TelegramClient } from "teleproto";
import type { TelegramBot } from "../src/bot.js";
import { Store } from "../src/database.js";
import { scanHistory } from "../src/history.js";
import type { IncomingMessage, Listing, SearchConfig } from "../src/types.js";

const config: SearchConfig = { channels: ["good_channel", "bad_channel"], filters: { dealType: "rent",
  propertyTypes: ["apartment"], city: "Львів", districts: ["Шевченківський"], rooms: [1, 2],
  maxPriceUah: 22000, requireExplicitDistrict: true } };

test("scans channel history, isolates channel errors and delivers every pending match", async () => {
  const directory = mkdtempSync(join(tmpdir(), "realty-history-"));
  const store = new Store(join(directory, "test.sqlite"));
  const oldMessage: IncomingMessage = { channel: "old", channelId: "9", messageId: 9,
    text: "Оренда 1-кімнатної квартири у Львові, Шевченківський район, 18000 грн",
    date: new Date("2026-10-28T08:00:00Z"), link: "https://t.me/old/9", edited: false };
  const oldListing: Listing = { dealType: "rent", propertyType: "apartment", city: "Львів",
    district: "Шевченківський", rooms: 1, priceUah: 18000, currency: "UAH",
    isLikelyBroker: false, isDemandPost: false, text: oldMessage.text };
  store.save(oldMessage, oldListing, true);

  const client = {
    async *iterMessages(entity: string) {
      if (entity === "@bad_channel") throw new Error("unavailable");
      yield { id: 10, chatId: "100", date: Date.parse("2026-10-29T09:00:00Z") / 1000,
        message: "Оренда 2-кімнатної квартири у Львові, Шевченківський район, 21000 грн" };
      yield { id: 8, chatId: "100", date: Date.parse("2026-10-27T09:00:00Z") / 1000,
        message: "Оренда 1-кімнатної квартири у Львові, Шевченківський район, 17000 грн" };
    }
  } as unknown as TelegramClient;
  const delivered: number[] = [];
  const bot = { async sendListing(message: IncomingMessage) { delivered.push(message.messageId); } } as unknown as TelegramBot;
  try {
    const preview = await scanHistory({ client, config, store, bot, days: 2, deliver: false,
      now: new Date("2026-10-29T12:00:00Z") });
    assert.equal(preview.newVersions, 1);
    assert.equal(preview.matched, 1);
    assert.deepEqual(store.stats(), { processed: 1, matched: 1, notified: 0 });

    const summary = await scanHistory({ client, config, store, bot, days: 2,
      now: new Date("2026-10-29T12:00:00Z") });
    assert.deepEqual(delivered.sort((a, b) => a - b), [9, 10]);
    assert.equal(summary.scanned, 1);
    assert.equal(summary.newVersions, 1);
    assert.equal(summary.matched, 1);
    assert.equal(summary.notified, 2);
    assert.equal(summary.failedChannels, 1);
    assert.deepEqual(store.stats(), { processed: 2, matched: 2, notified: 2 });

    delivered.length = 0;
    const repeated = await scanHistory({ client, config, store, bot, days: 2,
      now: new Date("2026-10-29T12:00:00Z") });
    assert.deepEqual(delivered, []);
    assert.equal(repeated.newVersions, 0);
    assert.equal(repeated.notified, 0);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("validates rescan day range", async () => {
  await assert.rejects(() => scanHistory({ client: {} as TelegramClient, config, store: {} as Store,
    bot: {} as TelegramBot, days: 0 }), /від 1 до 30/);
});
