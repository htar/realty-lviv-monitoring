import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TelegramBot } from "../src/bot.js";
import { Store } from "../src/database.js";
import type { IncomingMessage, Listing, SearchConfig } from "../src/types.js";

const originalFetch = globalThis.fetch;

function response(result: unknown, ok = true, status = 200): Response {
  return new Response(JSON.stringify(ok ? { ok: true, result } : { ok: false, description: result }), {
    status, headers: { "content-type": "application/json" }
  });
}

function config(): SearchConfig {
  return { channels: ["direct_rent"], filters: { dealType: "rent", propertyTypes: ["apartment"],
    city: "Львів", districts: ["Шевченківський"], rooms: [1, 2], maxPriceUah: 22000,
    requireExplicitDistrict: true } };
}

test("formats and escapes a listing notification", async () => {
  let sent: Record<string, unknown> | undefined;
  globalThis.fetch = async (_url, init) => {
    sent = JSON.parse(String(init?.body));
    return response({ message_id: 1 });
  };
  try {
    const bot = new TelegramBot("token", "42");
    const incoming: IncomingMessage = { channel: "direct_rent", channelId: "1", messageId: 7,
      text: "Квартира <центр> & ремонт", date: new Date(), link: "https://t.me/direct_rent/7", edited: false };
    const listing: Listing = { dealType: "rent", propertyType: "apartment", city: "Львів",
      district: "Шевченківський", rooms: 2, priceUah: 21500, currency: "UAH",
      isLikelyBroker: true, isDemandPost: false, text: incoming.text };
    await bot.sendListing(incoming, listing);
    assert.equal(sent?.chat_id, "42");
    assert.equal(sent?.parse_mode, "HTML");
    assert.match(String(sent?.text), /21 500 грн/);
    assert.match(String(sent?.text), /&lt;центр&gt; &amp; ремонт/);
    assert.match(String(sent?.text), /Ймовірно посередник/);
    assert.match(String(sent?.text), /https:\/\/t\.me\/direct_rent\/7/);
  } finally { globalThis.fetch = originalFetch; }
});

test("surfaces Bot API errors", async () => {
  globalThis.fetch = async () => response("Unauthorized", false, 401);
  try {
    const bot = new TelegramBot("bad", "42");
    const incoming: IncomingMessage = { channel: "test", channelId: "1", messageId: 1,
      text: "text", date: new Date(), link: "https://t.me/test/1", edited: false };
    const listing: Listing = { dealType: "rent", propertyType: "apartment", rooms: 1,
      priceUah: 10000, isLikelyBroker: false, isDemandPost: false, text: "text" };
    await assert.rejects(() => bot.sendListing(incoming, listing), /Unauthorized/);
  } finally { globalThis.fetch = originalFetch; }
});

test("formats fallback values when optional listing fields are absent", async () => {
  let text = "";
  globalThis.fetch = async (_url, init) => {
    text = String(JSON.parse(String(init?.body)).text);
    return response({ message_id: 1 });
  };
  try {
    const bot = new TelegramBot("token", "42");
    await bot.sendListing({ channel: "test_channel", channelId: "1", messageId: 1, text: "Оголошення",
      date: new Date(), link: "https://t.me/test_channel/1", edited: false },
    { dealType: "rent", propertyType: "apartment", isLikelyBroker: false, isDemandPost: false, text: "Оголошення" });
    assert.match(text, /Львів/);
    assert.match(text, /— грн/);
    assert.doesNotMatch(text, /Ймовірно посередник/);
  } finally { globalThis.fetch = originalFetch; }
});

test("processes authorized commands, ignores other chats and persists changes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "realty-bot-"));
  const store = new Store(join(directory, "test.sqlite"));
  const current = config();
  const bot = new TelegramBot("token", "42");
  const messages = [
    { update_id: 1, message: { chat: { id: 99 }, text: "/budget 99999" } },
    { update_id: 2, message: { chat: { id: 42 }, text: "/budget 25000" } },
    { update_id: 3, message: { chat: { id: 42 }, text: "/rooms wrong" } },
    { update_id: 4, message: { chat: { id: 42 }, text: "/rooms 1,3;3" } },
    { update_id: 5, message: { chat: { id: 42 }, text: "/district Шевченківський, Франківський" } },
    { update_id: 6, message: { chat: { id: 42 }, text: "/strict maybe" } },
    { update_id: 7, message: { chat: { id: 42 }, text: "/strict on" } },
    { update_id: 18, message: { chat: { id: 42 }, text: "/filters" } },
    { update_id: 19, message: { chat: { id: 42 }, text: "/strict off" } },
    { update_id: 8, message: { chat: { id: 42 }, text: "/channeladd https://t.me/new_channel" } },
    { update_id: 9, message: { chat: { id: 42 }, text: "/channeladd @new_channel" } },
    { update_id: 10, message: { chat: { id: 42 }, text: "/channeladd bad!" } },
    { update_id: 11, message: { chat: { id: 42 }, text: "/channelremove @direct_rent" } },
    { update_id: 12, message: { chat: { id: 42 }, text: "/channelremove @missing_channel" } },
    { update_id: 13, message: { chat: { id: 42 }, text: "/channels" } },
    { update_id: 14, message: { chat: { id: 42 }, text: "/filters" } },
    { update_id: 15, message: { chat: { id: 42 }, text: "/status" } },
    { update_id: 16, message: { chat: { id: 42 }, text: "/channelhelp" } },
    { update_id: 17, message: { chat: { id: 42 }, text: "/help" } }
  ];
  const sent: Array<Record<string, unknown>> = [];
  let polls = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/getUpdates")) {
      polls += 1;
      if (polls === 1) return response(messages);
      bot.stop();
      return response([]);
    }
    sent.push(JSON.parse(String(init?.body)));
    return response({ message_id: sent.length });
  };
  try {
    await bot.runCommands(store, current);
    assert.equal(current.filters.maxPriceUah, 25000);
    assert.deepEqual(current.filters.rooms, [1, 3]);
    assert.deepEqual(current.filters.districts, ["Шевченківський", "Франківський"]);
    assert.equal(current.filters.requireExplicitDistrict, false);
    assert.deepEqual(current.channels, ["new_channel"]);
    assert.deepEqual(store.loadChannels(), ["new_channel"]);
    assert.deepEqual(store.loadFilters(), current.filters);
    assert.equal(sent.length, 18);
    assert.ok(sent.every((body) => body.chat_id === "42"));
    assert.ok(sent.some((body) => String(body.text).includes("Активні джерела")));
    assert.ok(sent.some((body) => String(body.text).includes("Поточні фільтри")));
  } finally {
    globalThis.fetch = originalFetch;
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("covers empty and invalid command branches", async () => {
  const directory = mkdtempSync(join(tmpdir(), "realty-bot-"));
  const store = new Store(join(directory, "test.sqlite"));
  const current = config();
  current.channels = [];
  const bot = new TelegramBot("token", "42");
  const messages = [
    { update_id: 1, message: { chat: { id: 42 } } },
    { update_id: 2, message: { chat: { id: 42 }, text: "/start@my_bot" } },
    { update_id: 3, message: { chat: { id: 42 }, text: "/budget 999" } },
    { update_id: 4, message: { chat: { id: 42 }, text: "/district" } },
    { update_id: 5, message: { chat: { id: 42 }, text: "/channels" } },
    { update_id: 6, message: { chat: { id: 42 }, text: "/channelremove bad!" } },
    { update_id: 7, message: { chat: { id: 42 }, text: "/unknown" } }
  ];
  const sent: Array<Record<string, unknown>> = [];
  let polls = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/getUpdates")) {
      polls += 1;
      if (polls === 1) return response(messages);
      bot.stop();
      return response([]);
    }
    sent.push(JSON.parse(String(init?.body)));
    return response({ message_id: sent.length });
  };
  try {
    await bot.runCommands(store, current);
    assert.equal(sent.length, 5);
    assert.ok(sent.some((body) => String(body.text).includes("Немає активних каналів")));
    assert.ok(sent.some((body) => String(body.text).includes("бюджет цілим числом")));
    assert.ok(sent.some((body) => String(body.text).includes("Вкажіть район")));
  } finally {
    globalThis.fetch = originalFetch;
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("stops command polling cleanly after a network error", async () => {
  const directory = mkdtempSync(join(tmpdir(), "realty-bot-"));
  const store = new Store(join(directory, "test.sqlite"));
  const bot = new TelegramBot("token", "42");
  globalThis.fetch = async () => {
    bot.stop();
    throw new Error("network down");
  };
  try {
    await bot.runCommands(store, config());
  } finally {
    globalThis.fetch = originalFetch;
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("retries command polling after a transient network error", async () => {
  const directory = mkdtempSync(join(tmpdir(), "realty-bot-"));
  const store = new Store(join(directory, "test.sqlite"));
  const bot = new TelegramBot("token", "42", undefined, 0);
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("temporary");
    bot.stop();
    return response([]);
  };
  try {
    await bot.runCommands(store, config());
    assert.equal(attempts, 2);
  } finally {
    globalThis.fetch = originalFetch;
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("runs an authorized historical rescan command", async () => {
  const directory = mkdtempSync(join(tmpdir(), "realty-bot-"));
  const store = new Store(join(directory, "test.sqlite"));
  let requestedDays = 0;
  const bot = new TelegramBot("token", "42", async (days) => {
    requestedDays = days;
    return { firstDay: "2026-10-28", lastDay: "2026-10-29", timeZone: "Europe/Kyiv",
      scanned: 20, newVersions: 5, matched: 2, notified: 2, retriedPending: 2, failedChannels: 0, failedNotifications: 0 };
  });
  const sent: Array<Record<string, unknown>> = [];
  let polls = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/getUpdates")) {
      polls += 1;
      if (polls === 1) return response([
        { update_id: 1, message: { chat: { id: 42 }, text: "/rescan 0" } },
        { update_id: 2, message: { chat: { id: 42 }, text: "/rescan 2" } }
      ]);
      bot.stop();
      return response([]);
    }
    sent.push(JSON.parse(String(init?.body)));
    return response({ message_id: sent.length });
  };
  try {
    await bot.runCommands(store, config());
    assert.equal(requestedDays, 2);
    assert.equal(sent.length, 3);
    assert.ok(sent.some((body) => String(body.text).includes("від 1 до 30")));
    assert.ok(sent.some((body) => String(body.text).includes("Перевіряю активні канали")));
    assert.ok(sent.some((body) => String(body.text).includes("Повторна перевірка завершена")));
  } finally {
    globalThis.fetch = originalFetch;
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("reports unavailable and failed rescans", async () => {
  const directory = mkdtempSync(join(tmpdir(), "realty-bot-"));
  const store = new Store(join(directory, "test.sqlite"));
  const bots = [new TelegramBot("token", "42"), new TelegramBot("token", "42", async () => { throw new Error("MTProto down <x>"); })];
  try {
    for (const [index, bot] of bots.entries()) {
      const sent: Array<Record<string, unknown>> = [];
      let polls = 0;
      globalThis.fetch = async (url, init) => {
        if (String(url).endsWith("/getUpdates")) {
          polls += 1;
          if (polls === 1) return response([{ update_id: index + 1, message: { chat: { id: 42 }, text: "/rescan 1" } }]);
          bot!.stop();
          return response([]);
        }
        sent.push(JSON.parse(String(init?.body)));
        return response({ message_id: sent.length });
      };
      await bot!.runCommands(store, config());
      const combined = sent.map((body) => String(body.text)).join(" ");
      if (index === 0) assert.match(combined, /недоступне/);
      else assert.match(combined, /MTProto down &lt;x&gt;/);
    }
  } finally {
    globalThis.fetch = originalFetch;
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("reports health, inspects missed listings and stores quality feedback", async () => {
  const directory = mkdtempSync(join(tmpdir(), "realty-bot-"));
  const store = new Store(join(directory, "test.sqlite"));
  const inspected: number[] = [];
  const bot = new TelegramBot("token", "42", undefined, 0, async (days) => {
    inspected.push(days);
    return { firstDay: "2026-10-28", lastDay: "2026-10-29", timeZone: "Europe/Kyiv",
      scanned: 12, newVersions: 3, matched: 2, notified: 0, retriedPending: 0, failedChannels: 1, failedNotifications: 0 };
  }, () => ({ startedAt: new Date(Date.now() - 120_000), telegramConnected: true,
    lastUpdateAt: new Date(), lastRecoveryAt: new Date(), healthFailures: 0 }));
  const sent: any[] = [];
  let polls = 0;
  globalThis.fetch = async (url, init) => {
    const method = String(url).split("/").pop()!;
    const body = JSON.parse(String(init?.body));
    if (method === "getUpdates") {
      polls += 1;
      if (polls === 1) return response([
        { update_id: 1, callback_query: { id: "quality", data: "quality:bad:100:1", message: { chat: { id: 42 } } } },
        { update_id: 2, message: { chat: { id: 42 }, text: "/health" } },
        { update_id: 3, message: { chat: { id: 42 }, text: "/status" } },
        { update_id: 4, message: { chat: { id: 42 }, text: "/missed 0" } },
        { update_id: 5, message: { chat: { id: 42 }, text: "/missed 2" } }
      ]);
      bot.stop();
      return response([]);
    }
    sent.push(body);
    return response(true);
  };
  try {
    await bot.runCommands(store, config());
    assert.deepEqual(inspected, [2]);
    assert.deepEqual(store.feedbackStats(), { good: 0, bad: 1 });
    const text = sent.map((item) => String(item.text)).join("\n");
    assert.match(text, /Стан монітора/);
    assert.match(text, /Оцінки/);
    assert.match(text, /від 1 до 30/);
    assert.match(text, /Перевірку завершено/);
  } finally {
    globalThis.fetch = originalFetch;
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
