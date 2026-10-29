import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store, splitKey, splitChannelMessage } from "../src/database.js";
import { TelegramBot } from "../src/bot.js";
import { deliverListing, listingFingerprint } from "../src/notify.js";
import { runScheduledJobs, startScheduler, pruneBackups, digestText } from "../src/scheduler.js";
import { parseListing, matchesSearch } from "../src/parser.js";
import type { IncomingMessage, Listing, SearchConfig } from "../src/types.js";

const originalFetch = globalThis.fetch;

function config(): SearchConfig {
  return { channels: ["direct_rent"], filters: { dealType: "rent", propertyTypes: ["apartment"],
    city: "Львів", districts: ["Шевченківський"], rooms: [1, 2], maxPriceUah: 22000,
    requireExplicitDistrict: true } };
}

function response(result: unknown): Response {
  return new Response(JSON.stringify({ ok: true, result }), { headers: { "content-type": "application/json" } });
}

function message(id: number, text: string, channel = "direct_rent", channelId = "100"): IncomingMessage {
  return { channel, channelId, messageId: id, text, date: new Date(), link: `https://t.me/${channel}/${id}`, edited: false };
}

function withStore(run: (store: Store, dir: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "realty-features-"));
    const store = new Store(join(dir, "test.sqlite"));
    try { await run(store, dir); } finally {
      globalThis.fetch = originalFetch;
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

const LISTING = "Оренда 2-кімнатної квартири у Львові, Шевченківський район, 20000 грн. Тел 067 123 45 67";

test("skips the same flat reposted in another channel", withStore(async (store) => {
  const sent: Array<{ id: number; previousPrice?: number }> = [];
  const bot = { async sendListing(m: IncomingMessage, _l: Listing, o: { previousPrice?: number } = {}) {
    sent.push({ id: m.messageId, previousPrice: o.previousPrice }); } } as unknown as TelegramBot;
  const first = message(1, LISTING);
  const repost = message(7, `${LISTING} 🔥`, "lvivrentua", "200");
  for (const m of [first, repost]) {
    const listing = parseListing(m.text, config());
    const saved = store.save(m, listing, true);
    await deliverListing({ store, bot, message: m, listing, key: saved.key });
  }
  assert.deepEqual(sent.map((s) => s.id), [1]);
  assert.equal(store.pendingNotifications().length, 0);

  // An edit with a new price is announced even though the flat was sent before.
  const edited = { ...first, text: LISTING.replace("20000", "18000"), edited: true };
  const listing = parseListing(edited.text, config());
  const saved = store.save(edited, listing, true);
  assert.equal(await deliverListing({ store, bot, message: edited, listing, key: saved.key }), "sent");
  assert.deepEqual(sent[1], { id: 1, previousPrice: 20000 });
}));

test("concurrent and repeated delivery of one message sends it once", withStore(async (store) => {
  let sends = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const bot = { sendListing: async () => { sends += 1; await gate; } };
  const m = message(1, LISTING);
  const listing = parseListing(m.text, config());
  const saved = store.save(m, listing, true);
  const first = deliverListing({ store, bot, message: m, listing, key: saved.key });
  assert.equal(await deliverListing({ store, bot, message: m, listing, key: saved.key }), "skipped");
  release();
  assert.equal(await first, "sent");
  assert.equal(await deliverListing({ store, bot, message: m, listing, key: saved.key }), "skipped");
  assert.equal(sends, 1);
}));

test("pendingNotifications uses the injected clock for the fresh-message window", withStore(async (store) => {
  const m = { ...message(1, LISTING), date: new Date("2026-01-01T10:00:00Z") };
  store.save(m, parseListing(m.text, config()), true);
  assert.equal(store.pendingNotifications(500, 60, new Date("2026-01-01T10:00:30Z")).length, 0);
  assert.equal(store.pendingNotifications(500, 60, new Date("2026-01-01T10:02:00Z")).length, 1);
}));

test("site listings (channel id with a colon) are marked notified and buttons parse", withStore(async (store) => {
  assert.deepEqual(splitKey("site:rieltor.ua:13145813:abc"), ["site:rieltor.ua", "13145813", "abc"]);
  assert.deepEqual(splitKey("100:1:abc"), ["100", "1", "abc"]);
  assert.deepEqual(splitChannelMessage("site:rieltor.ua:13145813"), ["site:rieltor.ua", 13145813]);
  const m = message(13145813, LISTING, "rieltor.ua", "site:rieltor.ua");
  const listing = parseListing(m.text, config());
  const saved = store.save(m, listing, true);
  const bot = { sendListing: async () => {} };
  assert.equal(await deliverListing({ store, bot, message: m, listing, key: saved.key }), "sent");
  assert.equal(store.isNotified(saved.key), true);
  assert.equal(store.pendingNotifications().length, 0);
  assert.equal(store.summarySince(new Date(0)).notified, 1);
}));

test("fingerprint uses text when there is no phone", () => {
  const a = parseListing("Оренда квартири, Львів!!", config());
  const b = parseListing("оренда   квартири львів", config());
  assert.equal(listingFingerprint(a), listingFingerprint(b));
  assert.notEqual(listingFingerprint(a), listingFingerprint(parseListing(LISTING, config())));
});

test("store tracks favorites, reasons, summary and settings", withStore(async (store, dir) => {
  const cfg = config();
  const good = message(1, LISTING);
  const bad = message(2, "Продам квартиру у Львові");
  const goodListing = parseListing(good.text, cfg);
  const badListing = parseListing(bad.text, cfg);
  store.save(good, goodListing, true, []);
  store.save(bad, badListing, false, matchesSearch(badListing, cfg).reasons);
  assert.equal(store.previousPrice("100", 1, "100:1:nohash"), 20000);
  assert.equal(store.previousPrice("100", 99, "100:99:x"), undefined);

  assert.equal(store.addFavorite("100", 1), true);
  assert.equal(store.addFavorite("100", 1), false);
  store.addFavorite("100", 404);
  assert.deepEqual(store.favorites().map((f) => f.messageId), [1]);
  assert.equal(store.removeFavorite("100", 1), true);
  assert.equal(store.removeFavorite("100", 1), false);

  const since = new Date(Date.now() - 86_400_000);
  assert.ok(store.topReasons(since).some((r) => r.reason === "не визначено довгострокову оренду"));
  assert.deepEqual(store.summarySince(since), { processed: 2, matched: 1, notified: 0, avgMatchedPrice: 20000 });
  assert.deepEqual(store.summarySince(new Date(Date.now() + 86_400_000)), { processed: 0, matched: 0, notified: 0 });

  assert.equal(store.getSetting("x"), undefined);
  store.setSetting("x", "1");
  store.setSetting("x", "2");
  assert.equal(store.getSetting("x"), "2");
  assert.equal(store.wasSentRecently("fp"), false);
  store.rememberSent("fp", new Date(Date.now() - 10 * 86_400_000));
  assert.equal(store.wasSentRecently("fp"), false);
  store.rememberSent("fp");
  assert.equal(store.wasSentRecently("fp"), true);

  await store.backup(join(dir, "b", "copy.sqlite"));
  assert.deepEqual(readdirSync(join(dir, "b")), ["copy.sqlite"]);
}));

test("scheduler refreshes rates, backs up and sends the digest once a day", withStore(async (store, dir) => {
  const sent: string[] = [];
  let rateCalls = 0;
  const backupDir = join(dir, "backups");
  const deps = { store, backupDir, send: async (t: string) => { sent.push(t); },
    fetchRates: async () => { rateCalls += 1; return rateCalls > 1; } };
  const night = new Date("2026-10-30T03:00:00Z"); // 05:00 Kyiv (winter time, UTC+2)
  const morning = new Date("2026-10-30T05:30:00Z"); // 07:30 Kyiv
  await runScheduledJobs(deps, night);
  assert.equal(sent.length, 0);
  assert.deepEqual(readdirSync(backupDir), ["realty-2026-10-30.sqlite"]);
  await runScheduledJobs(deps, morning);
  await runScheduledJobs(deps, new Date(morning.getTime() + 60_000));
  assert.equal(rateCalls, 2); // first failed so it retried; second succeeded and is cached
  assert.equal(sent.length, 1);
  assert.match(sent[0]!, /Підсумок за 2026-10-29/);

  const failing = { ...deps, backupDir: join(dir, "test.sqlite", "nope"), send: async () => { throw new Error("down"); } };
  await runScheduledJobs(failing, new Date("2026-10-31T05:30:00Z"));
  assert.equal(store.getSetting("morning_digest_date"), "2026-10-29");
}));

test("digest counts only the reported day", withStore(async (store) => {
  const cfg = config();
  const posts = [[1, "2026-10-28T21:59:00Z"], [2, "2026-10-28T22:01:00Z"], [3, "2026-10-29T21:59:00Z"], [4, "2026-10-29T22:01:00Z"]] as const;
  for (const [id, iso] of posts) {
    const m = { ...message(id, LISTING), date: new Date(iso) };
    store.save(m, parseListing(m.text, cfg), true);
  }
  // Kyiv 2026-10-29 (winter time, UTC+2) = [2026-10-28T22:00Z, 2026-10-29T22:00Z): only posts 2 and 3.
  assert.match(digestText(store, "2026-10-29"), /Переглянуто: 2\n/);
}));

test("digest lists top reasons and backups are pruned", withStore(async (store, dir) => {
  const cfg = config();
  const bad = message(2, "Продам квартиру у Львові");
  bad.date = new Date("2026-10-29T10:00:00Z");
  const listing = parseListing(bad.text, cfg);
  store.save(bad, listing, false, matchesSearch(listing, cfg).reasons);
  assert.match(digestText(store, "2026-10-29"), /Найчастіше відхилялись/);

  for (let day = 1; day <= 9; day += 1) writeFileSync(join(dir, `realty-2026-10-0${day}.sqlite`), "");
  pruneBackups(dir, 7);
  assert.equal(readdirSync(dir).filter((n) => n.startsWith("realty-")).length, 7);
}));

test("startScheduler runs immediately and can be stopped", withStore(async (store, dir) => {
  let calls = 0;
  const stop = startScheduler({ store, backupDir: join(dir, "bk"), send: async () => {},
    fetchRates: async () => { calls += 1; return true; } }, 5);
  await new Promise((r) => setTimeout(r, 50));
  stop();
  assert.equal(calls, 1);
}));

test("bot buttons save and hide listings, new commands work", withStore(async (store) => {
  const cfg = config();
  const m = message(1, LISTING);
  store.save(m, parseListing(m.text, cfg), true);
  const bot = new TelegramBot("token", "42");
  const calls: Array<{ method: string; body: any }> = [];
  let polls = 0;
  globalThis.fetch = async (url, init) => {
    const method = String(url).split("/").pop()!;
    const body = JSON.parse(String(init?.body));
    if (method === "getUpdates") {
      polls += 1;
      const chat = { id: 42 };
      const msg = (text: string) => ({ update_id: polls * 100 + text.length, message: { chat, text } });
      if (polls === 1) return response([
        { update_id: 1, callback_query: { id: "q1", data: "fav:100:1", message: { chat, message_id: 5 } } },
        { update_id: 2, callback_query: { id: "q2", data: "fav:100:1", message: { chat, message_id: 5 } } },
        { update_id: 6, callback_query: { id: "q6", data: "quality:good:site:rieltor.ua:7", message: { chat, message_id: 5 } } },
        { update_id: 3, callback_query: { id: "q3", data: "hide", message: { chat, message_id: 5 } } },
        { update_id: 4, callback_query: { id: "q4", data: "hide", message: { chat: { id: 1 }, message_id: 5 } } },
        { update_id: 5, callback_query: { id: "q5", data: "boom", message: { chat, message_id: 5 } } }
      ]);
      if (polls === 2) return response(["/saved", "/unsave 9", "/unsave 1", "/saved", "/exclude", "/exclude подобово, Хостел",
        "/exclude", "/exclude off", "/nobroker x", "/nobroker on", "/nobroker off", "/why 0", "/why 30", "/why", "/filters", "/help"]
        .map((text, index) => ({ ...msg(text), update_id: 10 + index })));
      bot.stop();
      return response([]);
    }
    calls.push({ method, body });
    if (method === "answerCallbackQuery" && body.callback_query_id === "q5") throw new Error("network");
    return response(true);
  };
  await bot.runCommands(store, cfg);
  const answers = calls.filter((c) => c.method === "answerCallbackQuery").map((c) => c.body.text);
  assert.deepEqual(answers.slice(0, 4), ["⭐ Збережено. Список: /saved", "Уже в збережених", "✅ Дякую, збіг підтверджено", ""]);
  assert.equal(store.feedbackStats().good, 1);
  assert.equal(calls.filter((c) => c.method === "deleteMessage").length, 1);
  const texts = calls.filter((c) => c.method === "sendMessage").map((c) => String(c.body.text));
  assert.match(texts[0]!, /Збережені \(1\)/);
  assert.match(texts[1]!, /номер зі списку/);
  assert.match(texts[2]!, /Видалено/);
  assert.match(texts[3]!, /немає/);
  assert.match(texts[4]!, /Слів-виключень немає/);
  assert.match(texts[5]!, /подобово, хостел/);
  assert.match(texts[6]!, /Слова-виключення: подобово/);
  assert.match(texts[7]!, /очищено/);
  assert.match(texts[8]!, /Використання/);
  assert.match(texts[9]!, /приховуються/);
  assert.match(texts[10]!, /показуються/);
  assert.match(texts[11]!, /від 1 до 90/);
  assert.match(texts[12]!, /Немає даних/);
  assert.match(texts[13]!, /Немає даних/);
  assert.match(texts[14]!, /Посередники: з позначкою/);
  assert.match(texts[15]!, /\/saved/);
  assert.equal(cfg.filters.hideBrokers, false);
}));

test("why command lists stored reasons and sendText works", withStore(async (store) => {
  const cfg = config();
  const bad = message(2, "Продам квартиру у Львові");
  const listing = parseListing(bad.text, cfg);
  store.save(bad, listing, false, matchesSearch(listing, cfg).reasons);
  const bot = new TelegramBot("token", "42");
  const texts: string[] = [];
  let polls = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/getUpdates")) {
      polls += 1;
      if (polls === 1) return response([{ update_id: 1, message: { chat: { id: 42 }, text: "/why 7" } }]);
      bot.stop();
      return response([]);
    }
    texts.push(JSON.parse(String(init?.body)).text);
    return response(true);
  };
  await bot.runCommands(store, cfg);
  await bot.sendText("hello");
  assert.match(texts[0]!, /довгострокову оренду/);
  assert.equal(texts[1], "hello");
}));

test("listing notification shows price change, foreign price, phone and buttons", async () => {
  let body: any;
  globalThis.fetch = async (_url, init) => { body = JSON.parse(String(init?.body)); return response(true); };
  try {
    const bot = new TelegramBot("token", "42");
    const listing: Listing = { dealType: "rent", propertyType: "apartment", rooms: 1, priceUah: 16000, currency: "USD",
      originalPrice: 400, phones: ["+380671234567"], isLikelyBroker: false, isDemandPost: false, text: "x" };
    await bot.sendListing(message(3, "x"), listing, { previousPrice: 18000 });
    assert.match(body.text, /Змінилась ціна: 18\s000 → 16\s000/);
    assert.match(body.text, /\(400 USD\)/);
    assert.match(body.text, /📞 \+380671234567/);
    assert.equal(body.reply_markup.inline_keyboard[0][0].callback_data, "fav:100:3");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
