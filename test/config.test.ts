import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadEnv, loadSearchConfig } from "../src/config.js";

test("loads and coerces a complete environment", () => {
  const previous = { ...process.env };
  try {
    Object.assign(process.env, { TG_API_ID: "123", TG_API_HASH: "hash", TG_SESSION: "session",
      BOT_TOKEN: "token", BOT_CHAT_ID: "456" });
    delete process.env.DATABASE_PATH;
    delete process.env.LOG_LEVEL;
    const env = loadEnv();
    assert.equal(env.TG_API_ID, 123);
    assert.equal(env.DATABASE_PATH, "./data/realty.sqlite");
    assert.equal(env.LOG_LEVEL, "info");
  } finally {
    process.env = previous;
  }
});

test("rejects an incomplete environment", () => {
  const previous = { ...process.env };
  try {
    for (const key of ["TG_API_ID", "TG_API_HASH", "TG_SESSION", "BOT_TOKEN", "BOT_CHAT_ID"]) delete process.env[key];
    assert.throws(() => loadEnv());
  } finally { process.env = previous; }
});

test("normalizes and deduplicates channel usernames", () => {
  const directory = mkdtempSync(join(tmpdir(), "realty-config-"));
  try {
    const path = join(directory, "search.json");
    writeFileSync(path, JSON.stringify({ channels: ["@direct_rent", "direct_rent", "other_channel"], filters: {
      dealType: "rent", propertyTypes: ["apartment"], city: "Львів", districts: ["Шевченківський"],
      rooms: [1, 2], maxPriceUah: 22000
    } }));
    const config = loadSearchConfig(path);
    assert.deepEqual(config.channels, ["direct_rent", "other_channel"]);
    assert.equal(config.filters.requireExplicitDistrict, true);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("rejects invalid JSON and invalid search schemas", () => {
  const directory = mkdtempSync(join(tmpdir(), "realty-config-"));
  try {
    const invalidJson = join(directory, "invalid.json");
    writeFileSync(invalidJson, "{");
    assert.throws(() => loadSearchConfig(invalidJson), SyntaxError);
    const invalidSchema = join(directory, "schema.json");
    writeFileSync(invalidSchema, JSON.stringify({ channels: [], filters: {} }));
    assert.throws(() => loadSearchConfig(invalidSchema));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
