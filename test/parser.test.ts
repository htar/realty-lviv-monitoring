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
