import type { Listing, PropertyType, SearchConfig } from "./types.js";

const normalize = (value: string) => value
  .toLocaleLowerCase("uk-UA")
  .replace(/[’`]/g, "'")
  .replace(/\s+/g, " ")
  .trim();

const RENT = /(оренд\p{L}*|здам|здається|сдам|сдается|довгострок\p{L}*|довготривал\p{L}*)/iu;
const SALE = /(продам|продаж|продається|купівл\p{L}*|продается)/iu;
const APARTMENT = /(квартир\p{L}*|апартамент\p{L}*)/iu;
const HOUSE = /(будинок|будинку|будинк\p{L}*|дом|котедж\p{L}*)/iu;
const ROOM = /(кімнат\p{L}*|комнат\p{L}*)/iu;
const BROKER = /(рієлтор|риелтор|агентств\p{L}*|комісі[яї]|комисси[яи]|посередник)/iu;
const DEMAND_POST = /(?:шукаю|шукаємо|шукає|потрібна|потрібне|потрібен|зніму|ищу|ищем|ищет|нужна|нужно|нужен|сниму)(?:\s+[^\s,.!?]+){0,4}\s+(?:квартир\p{L}*|житл\p{L}*|кімнат\p{L}*|комнат\p{L}*|будинок|дом)/iu;

function detectRooms(text: string): number | undefined {
  const patterns = [
    /(?:^|\s)([1-9])\s*[-–]?\s*(?:кімн|комн)/iu,
    /(?:одно|одно-)кімнат/iu,
    /(?:дво|двох|двух|двух-)кімнат/iu
  ];
  const numeric = text.match(patterns[0]!);
  if (numeric?.[1]) return Number(numeric[1]);
  if (patterns[1]!.test(text)) return 1;
  if (patterns[2]!.test(text)) return 2;
  return undefined;
}

function detectPrice(text: string): Pick<Listing, "priceUah" | "currency"> {
  const candidates: Array<{ value: number; currency: "UAH" | "USD" | "EUR" }> = [];
  const regex = /(?:[$€]\s*)?(\d{2,3}(?:[\s.,]\d{3})?|\d+(?:[.,]\d+)?)\s*(тис\.?|тыс\.?|k)?\s*(грн|uah|₴|дол(?:ар(?:ів|а)?)?|usd|\$|євро|eur|€)?/giu;
  for (const match of text.matchAll(regex)) {
    if (!match[2] && !match[3]) continue;
    const raw = match[1]!.replace(/\s/g, "").replace(",", ".");
    let value = Number(raw);
    if (!Number.isFinite(value)) continue;
    if (match[2]) value *= 1000;
    const token = `${match[0]} ${match[3] ?? ""}`.toLowerCase();
    const currency = /\$|usd|дол/.test(token) ? "USD" : /€|eur|євро/.test(token) ? "EUR" : "UAH";
    candidates.push({ value: Math.round(value), currency });
  }
  const uah = candidates.filter((c) => c.currency === "UAH" && c.value >= 1000).sort((a, b) => b.value - a.value)[0];
  return uah ? { priceUah: uah.value, currency: "UAH" } : {};
}

function detectPropertyType(text: string): PropertyType {
  if (APARTMENT.test(text)) return "apartment";
  if (HOUSE.test(text)) return "house";
  if (ROOM.test(text)) return "room";
  return "unknown";
}

export function parseListing(rawText: string, config: SearchConfig): Listing {
  const text = normalize(rawText);
  const district = /шевчен(?:ківськ|ковск)/iu.test(text)
    ? config.filters.districts.find((item) => normalize(item).startsWith("шевчен"))
    : config.filters.districts.find((item) => text.includes(normalize(item).replace(/ський$/u, "ськ")));
  return {
    dealType: RENT.test(text) && !SALE.test(text) ? "rent" : SALE.test(text) ? "sale" : "unknown",
    propertyType: detectPropertyType(text),
    city: /(львів|львов|у львові|во львове)/iu.test(text) ? "Львів" : undefined,
    district,
    rooms: detectRooms(text),
    ...detectPrice(text),
    isLikelyBroker: BROKER.test(text),
    isDemandPost: DEMAND_POST.test(text),
    text: rawText.trim()
  };
}

export interface MatchResult { matches: boolean; reasons: string[] }

export function matchesSearch(listing: Listing, config: SearchConfig): MatchResult {
  const reasons: string[] = [];
  if (listing.isDemandPost) reasons.push("це запит на пошук житла, а не пропозиція");
  if (listing.dealType !== "rent") reasons.push("не визначено довгострокову оренду");
  if (!config.filters.propertyTypes.includes(listing.propertyType)) reasons.push("не квартира");
  if (listing.city !== config.filters.city) reasons.push("не вказано Львів");
  if (config.filters.requireExplicitDistrict && !listing.district) reasons.push("не вказано Шевченківський район");
  if (!listing.rooms || !config.filters.rooms.includes(listing.rooms)) reasons.push("не 1–2 кімнати");
  if (!listing.priceUah) reasons.push("не вдалося визначити ціну в гривнях");
  else if (listing.priceUah > config.filters.maxPriceUah) reasons.push("ціна понад 22 000 грн");
  return { matches: reasons.length === 0, reasons };
}
