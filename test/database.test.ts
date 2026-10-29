import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/database.js";
import Database from "better-sqlite3";
import type { IncomingMessage, Listing, SearchConfig } from "../src/types.js";

function message(text = "Оренда квартири"): IncomingMessage {
  return { channel: "test", channelId: "100", messageId: 1, text,
    date: new Date("2026-10-29T08:00:00Z"), link: "https://t.me/test/1", edited: false };
}

function listing(text = "Оренда квартири"): Listing {
  return { dealType: "rent", propertyType: "apartment", city: "Львів", district: "Шевченківський",
    rooms: 1, priceUah: 18000, currency: "UAH", isLikelyBroker: false, isDemandPost: false, text };
}

test("persists filter changes", () => {
  const directory = mkdtempSync(join(tmpdir(), "realty-monitoring-"));
  try {
    const path = join(directory, "test.sqlite");
    const filters: SearchConfig["filters"] = {
      dealType: "rent", propertyTypes: ["apartment"], city: "Львів",
      districts: ["Шевченківський", "Франківський"], rooms: [1, 2],
      maxPriceUah: 24000, requireExplicitDistrict: false
    };
    const store = new Store(path);
    store.saveFilters(filters);
    assert.deepEqual(store.loadFilters(), filters);
    store.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("persists active channels", () => {
  const directory = mkdtempSync(join(tmpdir(), "realty-monitoring-"));
  try {
    const store = new Store(join(directory, "test.sqlite"));
    store.saveChannels(["direct_rent", "lviv_no_maklers"]);
    assert.deepEqual(store.loadChannels(), ["direct_rent", "lviv_no_maklers"]);
    store.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("deduplicates identical versions and stores edited content as a new version", () => {
  const directory = mkdtempSync(join(tmpdir(), "realty-monitoring-"));
  try {
    const store = new Store(join(directory, "test.sqlite"));
    assert.equal(store.save(message(), listing(), true).isNewVersion, true);
    assert.equal(store.save(message(), listing(), true).isNewVersion, false);
    assert.equal(store.save(message("Оренда квартири, оновлена ціна"), listing("Оренда квартири, оновлена ціна"), true).isNewVersion, true);
    assert.deepEqual(store.stats(), { processed: 2, matched: 2, notified: 0 });
    store.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("marks a saved version as notified", () => {
  const directory = mkdtempSync(join(tmpdir(), "realty-monitoring-"));
  try {
    const store = new Store(join(directory, "test.sqlite"));
    const saved = store.save(message(), listing(), true);
    assert.equal(store.hasVersion(message()), true);
    assert.equal(store.hasVersion({ ...message(), messageId: 2 }), false);
    store.markNotified(saved.key);
    assert.deepEqual(store.stats(), { processed: 1, matched: 1, notified: 1 });
    store.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("returns pending matched notifications and skips corrupt parsed rows", () => {
  const directory = mkdtempSync(join(tmpdir(), "realty-monitoring-"));
  const path = join(directory, "test.sqlite");
  try {
    const store = new Store(path);
    const saved = store.save(message(), listing(), true);
    store.save({ ...message("Не підходить"), messageId: 2 }, listing("Не підходить"), false);
    let pending = store.pendingNotifications();
    assert.equal(pending.length, 1);
    assert.equal(pending[0]?.key, saved.key);
    assert.equal(pending[0]?.message.channel, "test");
    assert.equal(pending[0]?.listing.priceUah, 18000);
    store.close();
    const db = new Database(path);
    db.prepare("UPDATE messages SET parsed_json = 'bad-json' WHERE message_id = 1").run();
    db.close();
    const reopened = new Store(path);
    pending = reopened.pendingNotifications();
    assert.deepEqual(pending, []);
    reopened.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("returns undefined for settings that do not exist", () => {
  const directory = mkdtempSync(join(tmpdir(), "realty-monitoring-"));
  try {
    const store = new Store(join(directory, "test.sqlite"));
    assert.equal(store.loadFilters(), undefined);
    assert.equal(store.loadChannels(), undefined);
    store.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("ignores corrupt or wrongly shaped settings", () => {
  const directory = mkdtempSync(join(tmpdir(), "realty-monitoring-"));
  const path = join(directory, "test.sqlite");
  try {
    const store = new Store(path);
    store.close();
    const db = new Database(path);
    db.prepare("INSERT INTO settings (key,value,updated_at) VALUES (?,?,?)").run("filters", "not-json", new Date().toISOString());
    db.prepare("INSERT INTO settings (key,value,updated_at) VALUES (?,?,?)").run("channels", JSON.stringify({ bad: true }), new Date().toISOString());
    db.close();
    const reopened = new Store(path);
    assert.equal(reopened.loadFilters(), undefined);
    assert.equal(reopened.loadChannels(), undefined);
    reopened.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("filters non-string values from stored channels", () => {
  const directory = mkdtempSync(join(tmpdir(), "realty-monitoring-"));
  const path = join(directory, "test.sqlite");
  try {
    const store = new Store(path);
    store.close();
    const db = new Database(path);
    db.prepare("INSERT INTO settings (key,value,updated_at) VALUES (?,?,?)")
      .run("channels", JSON.stringify(["valid_channel", 42, null]), new Date().toISOString());
    db.close();
    const reopened = new Store(path);
    assert.deepEqual(reopened.loadChannels(), ["valid_channel"]);
    reopened.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("tracks delivery retries, health data, feedback and integrity", () => {
  const directory = mkdtempSync(join(tmpdir(), "realty-monitoring-"));
  try {
    const store = new Store(join(directory, "test.sqlite"));
    const saved = store.save(message(), listing(), true);
    assert.equal(store.integrityCheck(), true);
    assert.deepEqual(store.feedbackStats(), { good: 0, bad: 0 });
    store.recordFeedback("100", 1, "good");
    store.recordFeedback("100", 1, "bad");
    assert.deepEqual(store.feedbackStats(), { good: 0, bad: 1 });
    store.audit("test", "details");
    store.markDeliveryFailed(saved.key, new Error("offline"));
    assert.equal(store.pendingNotifications().length, 0);
    assert.deepEqual(store.deliveryStats().pending, 1);
    assert.deepEqual(store.deliveryStats().delayed, 1);
    store.markNotified(saved.key);
    assert.deepEqual(store.deliveryStats().pending, 0);
    store.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
