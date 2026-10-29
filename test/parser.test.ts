import test from "node:test";
import assert from "node:assert/strict";
import { parseListing, matchesSearch, detectPhones } from "../src/parser.js";
import { setRates, getRate, refreshRates } from "../src/rates.js";
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
  assert.match(matchesSearch(listing, config).reasons.join(" "), /не підходить тип житла/);
});

test("rejects missing city", () => {
  const listing = parseListing("Оренда 1-кімнатної квартири, Шевченківський район, 18000 грн", config);
  assert.match(matchesSearch(listing, config).reasons.join(" "), /не вказано Львів/);
});

test("rejects missing room count", () => {
  const listing = parseListing("Оренда квартири у Львові, Шевченківський район, 18000 грн", config);
  assert.match(matchesSearch(listing, config).reasons.join(" "), /кімнат не 1\/2/);
});

test("rejects missing UAH price", () => {
  const listing = parseListing("Оренда 1-кімнатної квартири у Львові, Шевченківський район", config);
  assert.match(matchesSearch(listing, config).reasons.join(" "), /не вдалося визначити ціну/);
});

test("converts USD and EUR rent to UAH", () => {
  setRates({ USD: 40, EUR: 45 });
  const usd = parseListing("Оренда 1-кімнатної квартири у Львові, Шевченківський район, $400", config);
  assert.equal(usd.priceUah, 16000);
  assert.equal(usd.currency, "USD");
  assert.equal(usd.originalPrice, 400);
  assert.equal(matchesSearch(usd, config).matches, true);
  const eur = parseListing("Оренда 2-кімнатної квартири у Львові, Шевченківський район, 600 євро", config);
  assert.equal(eur.priceUah, 27000);
  assert.match(matchesSearch(eur, config).reasons.join(" "), /понад 22\s000/);
  assert.equal(parseListing("Оренда квартири у Львові, депозит $20000", config).priceUah, undefined);
});

test("reasons follow the current filters", () => {
  const custom: SearchConfig = { ...config, filters: { ...config.filters, maxPriceUah: 15000, rooms: [3] } };
  const reasons = matchesSearch(parseListing("Оренда 2-кімнатної квартири у Львові, Шевченківський район, 18000 грн", custom), custom).reasons.join(" ");
  assert.match(reasons, /понад 15\s000/);
  assert.match(reasons, /кімнат не 3/);
});

test("detects studios and three-room spelling", () => {
  assert.equal(parseListing("Здам смарт-квартиру у Львові", config).rooms, 1);
  assert.equal(parseListing("Оренда студії у Львові", config).propertyType, "apartment");
  assert.equal(parseListing("Здається трикімнатна квартира", config).rooms, 3);
});

test("detects district by microdistrict alias", () => {
  assert.equal(parseListing("Оренда квартири, Львів, вул. Замарстинівська", config).district, "Шевченківський");
  const custom: SearchConfig = { ...config, filters: { ...config.filters, districtAliases: { "Шевченківський": ["рясне"] } } };
  assert.equal(parseListing("Оренда квартири, Львів, Рясне-2", custom).district, "Шевченківський");
});

test("extracts phone numbers", () => {
  assert.deepEqual(detectPhones("Тел: 067 123 45 67, +38 (050) 765-43-21, 0671234567"), ["+380671234567", "+380507654321"]);
  assert.equal(parseListing("Оренда без телефону", config).phones, undefined);
});

test("applies keyword exclusions and broker hiding", () => {
  const custom: SearchConfig = { ...config, filters: { ...config.filters, excludeKeywords: ["подобово", " "], hideBrokers: true } };
  const listing = parseListing("Оренда 1-кімнатної квартири у Львові, Шевченківський район, 18000 грн, подобово, комісія 50%", custom);
  const reasons = matchesSearch(listing, custom).reasons.join(" ");
  assert.match(reasons, /виключене слово «подобово»/);
  assert.match(reasons, /посередник/);
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

test("refreshes NBU rates and ignores failures", async () => {
  const ok = async () => new Response(JSON.stringify([{ cc: "USD", rate: 42 }, { cc: "EUR", rate: 49 }]));
  assert.equal(await refreshRates(ok as typeof fetch), true);
  assert.equal(getRate("USD"), 42);
  assert.equal(getRate("EUR"), 49);
  assert.equal(await refreshRates((async () => new Response("", { status: 500 })) as typeof fetch), false);
  assert.equal(await refreshRates((async () => { throw new Error("offline"); }) as typeof fetch), false);
  setRates({ USD: -1 });
  assert.equal(getRate("USD"), 42);
});
