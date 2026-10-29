import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRealEstateLviv, parseRieltor, toListing } from "../src/sites.js";
import { pollSites, startSiteMonitor } from "../src/site-monitor.js";
import { matchesSearch } from "../src/parser.js";
import { Store } from "../src/database.js";
import type { SearchConfig } from "../src/types.js";

const config: SearchConfig = {
  channels: ["test"],
  filters: { dealType: "rent", propertyTypes: ["apartment"], city: "Львів", districts: ["Шевченківський"], rooms: [1, 2], maxPriceUah: 22000, requireExplicitDistrict: true }
};
const rates = { UAH: 1, USD: 41, EUR: 45 };

const rieltorCard = (id: string, price: string, region: string, rooms = 1) => `
<div data-jss="catalog-item" data-catalog-item-id="${id}">
  <a class="catalog-card-media" href="https://rieltor.ua/lvov/flats-rent/view/${id}/"></a>
  <div class="catalog-card-price-title">${price}</div>
  <div class="catalog-card-details-row">${rooms} кімнати</div>
  <div class="catalog-card-details-row">34 / 18 / 8 м²</div>
  <div class="catalog-card-details-row">поверх 7 з 9</div>
  <div class="catalog-card-address">Мазепи вул., 6</div>
  <div class="catalog-card-region">${region}</div>
</div>`;

test("parses rieltor cards", () => {
  const [card] = parseRieltor(rieltorCard("101", "16 000 грн", "Львів , Шевченківський р-н"));
  assert.deepEqual(
    { id: card?.id, price: card?.price, currency: card?.currency, rooms: card?.rooms, floor: card?.floor, area: card?.area, city: card?.city, district: card?.district },
    { id: "101", price: 16000, currency: "UAH", rooms: 1, floor: 7, area: 34, city: "Львів", district: "Шевченківський" }
  );
});

test("parses real-estate.lviv.ua cards without mixing neighbours", () => {
  const card = (id: string, address: string) => `
    <div class="row"><a class="photo-obj-search-page" href="/${id}-kvartyra"><img src="/i.jpg"></a>
      <div class="object-listing-text">Оренда квартири</div>
      <div class="object-listing-price">17 500 грн</div>
      <div class="object-listing-price">1 кімн. 25 / 6 кв.м 3 / 9 пов</div>
      <div class="object-listing-address">${address}</div></div>`;
  const cards = parseRealEstateLviv(`<div class="col-dense-right">${card("5", "Творча вул., 12, Львів, Шевченківський район")}${card("6", "Пасічна вул., Львів, Личаківський район")}</div>`);
  assert.equal(cards.length, 2);
  assert.deepEqual(cards.map((c) => [c.id, c.district, c.address, c.floor]), [
    ["5", "Шевченківський", "Творча вул., 12", 3], ["6", "Личаківський", "Пасічна вул.", 3]
  ]);
});

test("site listing matches only in the configured district and converts USD", () => {
  const [inDistrict, otherDistrict, usd] = parseRieltor(
    rieltorCard("1", "16 000 грн", "Львів , Шевченківський р-н") +
    rieltorCard("2", "16 000 грн", "Львів , Галицький р-н") +
    rieltorCard("3", "500 $", "Львів , Шевченківський р-н")
  );
  assert.equal(matchesSearch(toListing(inDistrict!, config, rates).listing, config).matches, true);
  assert.equal(matchesSearch(toListing(otherDistrict!, config, rates).listing, config).matches, false);
  assert.equal(toListing(usd!, config, rates).listing.priceUah, 20500);
});

test("pollSites notifies once per listing and survives a failing site", async () => {
  const store = new Store(join(mkdtempSync(join(tmpdir(), "sites-")), "db.sqlite"));
  const sent: string[] = [];
  const deps = {
    config, store,
    bot: { sendListing: async (m: { link: string }) => { sent.push(m.link); } },
    logger: { info() {}, warn() {}, error() {} },
    getRates: async () => rates,
    fetchHtml: async (url: string) => {
      if (url.includes("real-estate.lviv.ua")) throw new Error("HTTP 429");
      return rieltorCard("7", "18 000 грн", "Львів , Шевченківський р-н", 2) + rieltorCard("8", "30 000 грн", "Львів , Шевченківський р-н");
    }
  };
  assert.deepEqual(await pollSites(deps as any), { seen: 2, notified: 1 });
  assert.deepEqual(await pollSites(deps as any), { seen: 2, notified: 0 });
  assert.deepEqual(sent, ["https://rieltor.ua/lvov/flats-rent/view/7/"]);
  store.close();
});

test("pollSites handles missing rates, empty pages and send failures", async () => {
  const store = new Store(join(mkdtempSync(join(tmpdir(), "sites-")), "db.sqlite"));
  const warnings: string[] = [];
  const errors: string[] = [];
  const deps = {
    config, store,
    bot: { sendListing: async () => { throw new Error("Bot API down"); } },
    logger: { info() {}, warn(_o: unknown, msg: string) { warnings.push(msg); }, error(_o: unknown, msg: string) { errors.push(msg); } },
    getRates: async () => { throw new Error("NBU down"); },
    fetchHtml: async (url: string) => url.includes("rieltor")
      ? rieltorCard("9", "18 000 грн", "Львів , Шевченківський р-н", 2) + rieltorCard("10", "400 $", "Львів , Шевченківський р-н")
      : "<html></html>"
  };
  assert.deepEqual(await pollSites(deps as any), { seen: 2, notified: 0 });
  assert.ok(warnings.some((w) => /NBU rates unavailable/.test(w)));
  assert.ok(warnings.some((w) => /0 listings/.test(w)));
  assert.deepEqual(errors, ["site notification failed"]);
  store.close();
});

test("startSiteMonitor polls immediately and can be stopped", async () => {
  const store = new Store(join(mkdtempSync(join(tmpdir(), "sites-")), "db.sqlite"));
  let fetches = 0;
  const stop = startSiteMonitor({ config, store, bot: { sendListing: async () => {} },
    logger: { info() {}, warn() {}, error() {} }, getRates: async () => rates,
    fetchHtml: async () => { fetches += 1; return ""; } } as any, 10_000);
  await new Promise((r) => setTimeout(r, 50));
  stop();
  assert.ok(fetches >= 1);
  store.close();
});

test("pollSites uses the default HTTP fetcher with browser headers", async () => {
  const store = new Store(join(mkdtempSync(join(tmpdir(), "sites-")), "db.sqlite"));
  const original = globalThis.fetch;
  const agents: string[] = [];
  const errors: string[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    agents.push(String((init.headers as Record<string, string>)["User-Agent"]));
    return String(url).includes("rieltor") ? new Response(rieltorCard("11", "18 000 грн", "Львів , Шевченківський р-н", 2))
      : new Response("blocked", { status: 403 });
  }) as typeof fetch;
  try {
    const result = await pollSites({ config, store, bot: { sendListing: async () => {} }, getRates: async () => rates,
      logger: { info() {}, warn() {}, error(_o: unknown, msg: string) { errors.push(msg); } } } as any);
    assert.deepEqual(result, { seen: 1, notified: 1 });
    assert.ok(agents.every((a) => a.startsWith("Mozilla/5.0")));
    assert.deepEqual(errors, ["site scrape failed"]);
  } finally {
    globalThis.fetch = original;
    store.close();
  }
});

test("parsers skip incomplete cards and handle sparse ones", () => {
  const sparse = `<div data-jss="catalog-item" data-catalog-item-id="20">
    <a class="catalog-card-media" href="https://rieltor.ua/x/20/"></a>
    <div class="catalog-card-price-title">700 €</div>
    <div class="catalog-card-details-row">2 кімнати</div></div>`;
  const noPrice = `<div data-jss="catalog-item" data-catalog-item-id="21">
    <a class="catalog-card-media" href="https://rieltor.ua/x/21/"></a>
    <div class="catalog-card-details-row">2 кімнати</div></div>`;
  const noId = `<div data-jss="catalog-item"><div class="catalog-card-price-title">9 000 грн</div></div>`;
  const cards = parseRieltor(sparse + noPrice + noId);
  assert.equal(cards.length, 1);
  assert.deepEqual([cards[0]?.currency, cards[0]?.city, cards[0]?.district, cards[0]?.address, cards[0]?.area],
    ["EUR", "Львів", null, "Львів", null]);

  const lviv = (inner: string, href = "/30-kvartyra") => `<div class="row"><a class="photo-obj-search-page" href="${href}"></a>${inner}</div>`;
  const html = `<div class="col-dense-right">${[
    lviv(`<div class="object-listing-price">600 €</div><div class="object-listing-price">1 кімн. 30 кв.м</div>
      <div class="object-listing-address">Шевченківський район</div>`),
    lviv(`<div class="object-listing-price">ціна договірна</div>`, "/31-kvartyra"),
    lviv(`<div class="object-listing-price">9 000 грн</div>`, "/bad-link"),
    `<div class="row"><a class="photo-obj-search-page"></a></div>`
  ].join("")}</div>`;
  const parsed = parseRealEstateLviv(html);
  assert.equal(parsed.length, 1);
  assert.deepEqual([parsed[0]?.currency, parsed[0]?.district, parsed[0]?.city, parsed[0]?.title],
    ["EUR", "Шевченківський", "Львів", "Оренда, Львів"]);
});

test("real-estate.lviv.ua card without district keeps the settlement as city", () => {
  const html = `<div class="col-dense-right"><div class="row"><a class="photo-obj-search-page" href="/77-kvartyra"></a>
    <div class="object-listing-price">500 $</div><div class="object-listing-price">2 кімн. 50 кв.м</div>
    <div class="object-listing-address">Шевченка вул., с. Зимна Вода</div></div></div>`;
  const [card] = parseRealEstateLviv(html);
  assert.equal(card?.district, null);
  assert.equal(card?.currency, "USD");
  assert.equal(card?.floor, null);
});
