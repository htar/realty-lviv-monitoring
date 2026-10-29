import test from "node:test";
import assert from "node:assert/strict";
import { StreetIndex, defaultStreetIndex, parseStreetTable, stem, type StreetRecord } from "../src/streets.js";
import { parseListing, matchesSearch } from "../src/parser.js";
import type { SearchConfig } from "../src/types.js";

const config: SearchConfig = {
  channels: ["test"],
  filters: { dealType: "rent", propertyTypes: ["apartment"], city: "Львів", districts: ["Шевченківський"],
    rooms: [1, 2], maxPriceUah: 22000, requireExplicitDistrict: true }
};

const WIKITEXT = `{| class="wide"
! width=180 | Назва
! width=45 | Тип
! Колишні назви
! width=90 | Район
! width=150 | Місцевість
! width=60 | {{Abbr|Рік затв.|x|}}
|- bgcolor=lightyellow
| [[Вулиця Замарстинівська|Замарстинівська]] || вулиця || Муроване Мости, Калініна; ділянка вулиці між 1 та 2 || [[Галицький район (Львів)|Галицький]], [[Шевченківський район (Львів)|Шевченківський]] || [[Замарстинів]] || 1990
|- bgcolor=lightyellow
| ''Зникла'' || вулиця || || [[Галицький район (Львів)|Галицький]] || || 1900
|-
| [[Вулиця X|Нерайонна]] || вулиця || || Невідомий || || 1990
|-
| [[Вулиця Ждахи|Ждахи Амвросія]] || вулиця || Артільна<ref>x</ref> || [[Шевченківський район (Львів)|Шевченківський]]<br>[[Шевченківський район (Львів)|Шевченківський]] || [[Голоско]] || 1993
|}`;

test("parses Wikipedia street tables, keeping every district of a street", () => {
  const rows = parseStreetTable(WIKITEXT);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { name: "Замарстинівська", type: "вулиця", districts: ["Галицький", "Шевченківський"],
    localities: ["Замарстинів"], formerNames: ["Муроване Мости", "Калініна"] });
  assert.deepEqual(rows[1]?.districts, ["Шевченківський"]);
  assert.deepEqual(rows[1]?.formerNames, ["Артільна"]);
});

test("stem folds case endings and Ukrainian/Russian spelling", () => {
  assert.equal(stem("Замарстинівській"), stem("Замарстинівська"));
  assert.equal(stem("Сихові"), stem("Сихів"));
  assert.equal(stem("Городоцкая"), stem("Городоцька"));
  assert.equal(stem("лес"), "лес");
});

test("bundled dataset recognises streets in any case and keeps multi-district streets", () => {
  const index = defaultStreetIndex()!;
  assert.ok(index.streets.length > 1000);
  const labels = (text: string) => index.find(text).map((m) => `${m.label}:${m.districts.join("+")}`);
  assert.deepEqual(labels("Здам 1к на вул. Замарстинівській"), ["вулиця Замарстинівська:Галицький+Шевченківський"]);
  assert.deepEqual(labels("Наукова вулиця, новобуд"), ["вулиця Наукова:Франківський"]);
  assert.deepEqual(labels("вул. Тараса Шевченка 45"), ["вулиця Шевченка Тараса:Шевченківський"]);
  assert.deepEqual(labels("просп. Шевченка"), ["проспект Шевченка Тараса:Галицький"]);
  assert.deepEqual(labels("ул. Городоцкая"), ["вулиця Городоцька:Галицький+Залізничний+Франківський"]);
  assert.deepEqual(labels("квартира на Голоску"), ["Голоско:Шевченківський"]);
  assert.deepEqual(labels("Новий ремонт, тихий двір, вид на гори"), []);
  assert.equal(defaultStreetIndex(), index);
});

test("former street names are used when no current street matches", () => {
  const streets: StreetRecord[] = [
    { name: "Новаторська", type: "вулиця", districts: ["Сихівський"], localities: [], formerNames: ["Калініна"] },
    { name: "Перша", type: "площа", districts: ["Галицький"], localities: ["Центр"], formerNames: [] }
  ];
  const index = new StreetIndex(streets);
  assert.deepEqual(index.find("вул. Калініна 5").map((m) => m.districts), [["Сихівський"]]);
  assert.deepEqual(index.find("пл. Перша, центр").map((m) => m.label), ["площа Перша"]);
  assert.deepEqual(index.find("вул. Невідома"), []);
});

test("parser infers the district from a street, including streets in several districts", () => {
  const listing = parseListing("Оренда 2-кімнатної квартири у Львові, вул. Замарстинівська, 20000 грн", config);
  assert.equal(listing.district, "Шевченківський");
  assert.equal(listing.location, "вулиця Замарстинівська");
  assert.equal(matchesSearch(listing, config).matches, true);

  const other = parseListing("Оренда 2-кімнатної квартири у Львові, вул. Наукова, 20000 грн", config);
  assert.equal(other.district, undefined);

  // An explicitly named other district wins over a street that crosses districts.
  const explicit = parseListing("Оренда 2-кімнатної квартири у Львові, Галицький район, вул. Замарстинівська, 20000 грн", config);
  assert.equal(explicit.district, undefined);

  const russian = parseListing("Сдается 1-комнатная квартира, Львов, Шевченковский район, 18 тыс грн", config);
  assert.equal(russian.district, "Шевченківський");
  assert.equal(russian.location, undefined);
});
