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
    store.markNotified(saved.key);
    assert.deepEqual(store.stats(), { processed: 1, matched: 1, notified: 1 });
    store.close();
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
