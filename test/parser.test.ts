import test from "node:test";
import assert from "node:assert/strict";
import { parseListing, matchesSearch } from "../src/parser.js";
import type { SearchConfig } from "../src/types.js";

const config: SearchConfig = {
  channels: ["test"],
  filters: { dealType: "rent", propertyTypes: ["apartment"], city: "Львів", districts: ["Шевченківський"], rooms: [1, 2], maxPriceUah: 22000, requireExplicitDistrict: true }
};

test("matches a Ukrainian rental listing", () => {
  const listing = parseListing("Оренда 2-кімнатної квартири у Львові, Шевченківський район. 21 500 грн/міс, без комісії", config);
  assert.equal(listing.rooms, 2);
  assert.equal(listing.priceUah, 21500);
  assert.equal(matchesSearch(listing, config).matches, true);
});

test("matches a Russian listing with compact price", () => {
  const listing = parseListing("Сдается 1-комнатная квартира, Львов, Шевченковский район, 18 тыс грн", config);
  assert.equal(listing.rooms, 1);
  assert.equal(listing.priceUah, 18000);
  assert.equal(matchesSearch(listing, config).matches, true);
});

test("rejects over-budget listing", () => {
  const listing = parseListing("Оренда 2-кімнатної квартири, Львів, Шевченківський район — 25 000 грн", config);
  assert.equal(matchesSearch(listing, config).matches, false);
});

test("rejects missing district to avoid false positives", () => {
  const listing = parseListing("Оренда 1-кімнатної квартири у Львові за 19000 грн", config);
  assert.equal(matchesSearch(listing, config).matches, false);
});

test("rejects a Ukrainian apartment wanted post", () => {
  const listing = parseListing("Шукаю квартиру у Львові, Шевченківський район, 1-2 кімнати, бюджет до 22000 грн", config);
  assert.equal(listing.isDemandPost, true);
  assert.equal(matchesSearch(listing, config).matches, false);
});

test("rejects a plural apartment wanted post", () => {
  const listing = parseListing("Шукаємо квартиру у Львові, Шевченківський район. 2 кімнати, до 20 000 грн", config);
  assert.equal(listing.isDemandPost, true);
  assert.equal(matchesSearch(listing, config).matches, false);
});

test("rejects a Russian apartment wanted post", () => {
  const listing = parseListing("Ищу 1-комнатную квартиру во Львове, Шевченковский район, до 18000 грн", config);
  assert.equal(listing.isDemandPost, true);
  assert.equal(matchesSearch(listing, config).matches, false);
});

test("detects sale and rejects it", () => {
  const listing = parseListing("Продаж 2-кімнатної квартири, Львів, Шевченківський район, 21000 грн", config);
  assert.equal(listing.dealType, "sale");
  assert.equal(matchesSearch(listing, config).matches, false);
});

test("rejects a house when only apartments are enabled", () => {
  const listing = parseListing("Оренда будинку у Львові, Шевченківський район, 2 кімнати, 20000 грн", config);
  assert.equal(listing.propertyType, "house");
  assert.equal(matchesSearch(listing, config).matches, false);
});

test("detects a room property", () => {
  const listing = parseListing("Оренда кімнати у Львові, Шевченківський район, 1 кімната, 8000 грн", config);
  assert.equal(listing.propertyType, "room");
});

test("keeps unknown property type from matching", () => {
  const listing = parseListing("Оренда житла у Львові, Шевченківський район, 2 кімнати, 20000 грн", config);
  assert.equal(listing.propertyType, "unknown");
  assert.match(matchesSearch(listing, config).reasons.join(" "), /не квартира/);
});

test("rejects missing city", () => {
  const listing = parseListing("Оренда 1-кімнатної квартири, Шевченківський район, 18000 грн", config);
  assert.match(matchesSearch(listing, config).reasons.join(" "), /не вказано Львів/);
});

test("rejects missing room count", () => {
  const listing = parseListing("Оренда квартири у Львові, Шевченківський район, 18000 грн", config);
  assert.match(matchesSearch(listing, config).reasons.join(" "), /не 1–2 кімнати/);
});

test("rejects missing UAH price", () => {
  const listing = parseListing("Оренда 1-кімнатної квартири у Львові, Шевченківський район", config);
  assert.match(matchesSearch(listing, config).reasons.join(" "), /ціну в гривнях/);
});

test("recognizes USD but deliberately does not convert it", () => {
  const listing = parseListing("Оренда 1-кімнатної квартири у Львові, Шевченківський район, $400", config);
  assert.equal(listing.priceUah, undefined);
  assert.equal(listing.currency, undefined);
  assert.equal(matchesSearch(listing, config).matches, false);
});

test("detects broker or commission language", () => {
  const listing = parseListing("Оренда 1-кімнатної квартири у Львові, Шевченківський район, 18000 грн, комісія рієлтора", config);
  assert.equal(listing.isLikelyBroker, true);
});

test("supports a verbal one-room spelling", () => {
  assert.equal(parseListing("Здам однокімнатну квартиру у Львові, Шевченківський район, 18000 грн", config).rooms, 1);
});

test("supports a verbal two-room spelling", () => {
  assert.equal(parseListing("Здається двохкімнатна квартира у Львові, Шевченківський район, 21000 грн", config).rooms, 2);
});

test("strict off allows a missing district", () => {
  const relaxed = structuredClone(config);
  relaxed.filters.requireExplicitDistrict = false;
  const listing = parseListing("Оренда 1-кімнатної квартири у Львові за 19000 грн", relaxed);
  assert.equal(matchesSearch(listing, relaxed).matches, true);
});

test("matches another configured Ukrainian district", () => {
  const multiDistrict = structuredClone(config);
  multiDistrict.filters.districts.push("Франківський");
  const listing = parseListing("Оренда 2-кімнатної квартири, Львів, Франківський район, 21000 грн", multiDistrict);
  assert.equal(listing.district, "Франківський");
  assert.equal(matchesSearch(listing, multiDistrict).matches, true);
});

test("rejects additional demand formulations", () => {
  for (const text of [
    "Потрібна квартира Львів Шевченківський район 1 кімната 20000 грн",
    "Зніму квартиру у Львові Шевченківський район 2 кімнати 21000 грн",
    "Сниму квартиру Львов Шевченковский район 1 комната 18000 грн"
  ]) {
    const listing = parseListing(text, config);
    assert.equal(listing.isDemandPost, true, text);
    assert.equal(matchesSearch(listing, config).matches, false, text);
  }
});
