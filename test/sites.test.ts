import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRealEstateLviv, parseRieltor, toListing } from "../src/sites.js";
import { pollSites } from "../src/site-monitor.js";
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
