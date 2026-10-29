import type { Listing, PropertyType, SearchConfig } from "./types.js";
import { getRate } from "./rates.js";
import { defaultStreetIndex } from "./streets.js";

const normalize = (value: string) => value
  .toLocaleLowerCase("uk-UA")
  .replace(/[’`]/g, "'")
  .replace(/\s+/g, " ")
  .trim();

const RENT = /(оренд\p{L}*|здам|здається|сдам|сдается|довгострок\p{L}*|довготривал\p{L}*)/iu;
const SALE = /(продам|продаж|продається|купівл\p{L}*|продается)/iu;
const APARTMENT = /(квартир\p{L}*|апартамент\p{L}*|студі\p{L}*|смарт\p{L}*)/iu;
const HOUSE = /(будинок|будинку|будинк\p{L}*|дом|котедж\p{L}*)/iu;
const ROOM = /(?:(?:оренд\p{L}*|здам|здається|сдам|сдается)\s+(?:окрем\p{L}*\s+)?(?:кімнат\p{L}*|комнат\p{L}*)|(?:кімнат\p{L}*|комнат\p{L}*)\s+(?:у|в)\s+квартир\p{L}*)/iu;
const BROKER = /(рієлтор|риелтор|агентств\p{L}*|комісі[яї]|комисси[яи]|посередник)/iu;
const DEMAND_POST = /(?:шукаю|шукаємо|шукає|потрібна|потрібне|потрібен|зніму|ищу|ищем|ищет|нужна|нужно|нужен|сниму)(?:\s+[^\s,.!?]+){0,4}\s+(?:квартир\p{L}*|житл\p{L}*|кімнат\p{L}*|комнат\p{L}*|будинок|дом)/iu;


function detectRooms(text: string): number | undefined {
  const numeric = text.match(/(?:^|\s)([1-9])\s*[-–]?\s*(?:х\s*)?(?:кімн|комн|к\b)/iu);
  if (numeric?.[1]) return Number(numeric[1]);
  if (/(?:одно|одно-)(?:кімнат|комнат)/iu.test(text)) return 1;
  if (/(?:дво|двох|двух)-?(?:кімнат|комнат)/iu.test(text)) return 2;
  if (/(?:три|трьох|трех)-?(?:кімнат|комнат)/iu.test(text)) return 3;
  if (/(?:студі|смарт)/iu.test(text)) return 1;
  return undefined;
}

type PriceCandidate = { value: number; currency: "UAH" | "USD" | "EUR" };

function detectPrice(text: string): Pick<Listing, "priceUah" | "currency" | "originalPrice"> {
  const candidates: PriceCandidate[] = [];
  const regex = /([$€]\s*)?(\d{1,3}(?:[\s.,]\d{3})+|\d{4,7}|\d+(?:[.,]\d+)?)\s*(тис\.?|тыс\.?|k)?\s*(грн|uah|₴|дол(?:ар(?:ів|а)?)?|usd|у\.\s?о\.|\$|євро|евро|eur|€)?/giu;
  for (const match of text.matchAll(regex)) {
    if (!match[1] && !match[3] && !match[4]) continue;
    const raw = match[2]!.replace(/\s/g, "");
    let value = Number(match[3] ? raw.replace(",", ".") : raw.replace(/[.,](?=\d{3}$)/, ""));
    if (!Number.isFinite(value)) continue;
    if (match[3]) value *= 1000;
    const token = `${match[1] ?? ""} ${match[4] ?? ""}`.toLowerCase();
    const currency = /\$|usd|дол|у\.\s?о/.test(token) ? "USD" : /€|eur|євро|евро/.test(token) ? "EUR" : "UAH";
    candidates.push({ value: Math.round(value), currency });
  }
  const uah = candidates.filter((c) => c.currency === "UAH" && c.value >= 1000).sort((a, b) => b.value - a.value)[0];
  if (uah) return { priceUah: uah.value, currency: "UAH" };
  // Rent in foreign currency: plausible monthly range only, so deposits or years are not picked up.
  const foreign = candidates.find((c) => c.currency !== "UAH" && c.value >= 100 && c.value <= 5000);
  if (!foreign) return {};
  const currency = foreign.currency as "USD" | "EUR";
  return { priceUah: Math.round(foreign.value * getRate(currency)), currency, originalPrice: foreign.value };
}

function detectPropertyType(text: string): PropertyType {
  if (APARTMENT.test(text)) return "apartment";
  if (HOUSE.test(text)) return "house";
  if (ROOM.test(text)) return "room";
  return "unknown";
}

/** Extracts Ukrainian phone numbers in +380XXXXXXXXX form. */
export function detectPhones(text: string): string[] {
  const phones = new Set<string>();
  for (const match of text.matchAll(/(?:\+?38)?[\s(-]*0\d{2}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}/g)) {
    const digits = match[0].replace(/\D/g, "").replace(/^38/, "");
    if (digits.length === 10) phones.add(`+38${digits}`);
  }
  return [...phones];
}

/** "Галицький район", "Сихівський р-н" (also Russian spellings) — an explicitly named Lviv district. */
const DISTRICT_MENTION = /(галицьк|галицк|залізничн|железнодорожн|личаківськ|лычаковск|личаковск|сихівськ|сыховск|сиховск|франківськ|франковск|шевченківськ|шевченковск)\p{L}*\s+(?:район|р-н)/iu;

function detectDistrict(text: string, config: SearchConfig, streets = defaultStreetIndex()): Pick<Listing, "district" | "location"> {
  const { districts } = config.filters;
  const named = districts.find((district) => text.includes(normalize(district).replace(/ський$/u, "ськ")))
    ?? (/шевченковск/u.test(text) ? districts.find((d) => normalize(d).startsWith("шевчен")) : undefined);
  if (named) return { district: named };
  // The post names some other district explicitly: trust it over street guesses.
  if (DISTRICT_MENTION.test(text)) return {};
  const aliases = config.filters.districtAliases ?? {};
  const aliased = districts.find((district) => (aliases[district] ?? []).some((word) => word.trim() && text.includes(normalize(word))));
  if (aliased) return { district: aliased };
  // Street or locality; a street crossing several districts counts for each of them.
  for (const match of streets?.find(text) ?? []) {
    const district = districts.find((d) => match.districts.includes(d));
    if (district) return { district, location: match.label };
  }
  return {};
}

export function parseListing(rawText: string, config: SearchConfig): Listing {
  const text = normalize(rawText);
  const phones = detectPhones(rawText);
  return {
    dealType: RENT.test(text) && !SALE.test(text) ? "rent" : SALE.test(text) ? "sale" : "unknown",
    propertyType: detectPropertyType(text),
    city: /(львів|львов|у львові|во львове)/iu.test(text) ? "Львів" : undefined,
    ...detectDistrict(text, config),
    rooms: detectRooms(text),
    ...detectPrice(text),
    ...(phones.length ? { phones } : {}),
    isLikelyBroker: BROKER.test(text),
    isDemandPost: DEMAND_POST.test(text),
    text: rawText.trim()
  };
}

export interface MatchResult { matches: boolean; reasons: string[] }

export function matchesSearch(listing: Listing, config: SearchConfig): MatchResult {
  const { filters } = config;
  const reasons: string[] = [];
  const text = normalize(listing.text);
  if (listing.isDemandPost) reasons.push("це запит на пошук житла, а не пропозиція");
  if (listing.dealType !== "rent") reasons.push("не визначено довгострокову оренду");
  if (!filters.propertyTypes.includes(listing.propertyType)) reasons.push("не підходить тип житла");
  if (listing.city !== filters.city) reasons.push(`не вказано ${filters.city}`);
  if (filters.requireExplicitDistrict && !listing.district) reasons.push(`не вказано район: ${filters.districts.join(", ")}`);
  if (!listing.rooms || !filters.rooms.includes(listing.rooms)) reasons.push(`кімнат не ${filters.rooms.join("/")}`);
  if (!listing.priceUah) reasons.push("не вдалося визначити ціну");
  else if (listing.priceUah > filters.maxPriceUah) reasons.push(`ціна понад ${filters.maxPriceUah.toLocaleString("uk-UA")} грн`);
  if (filters.hideBrokers && listing.isLikelyBroker) reasons.push("ймовірно посередник");
  const excluded = (filters.excludeKeywords ?? []).find((word) => word.trim() && text.includes(normalize(word)));
  if (excluded) reasons.push(`містить виключене слово «${excluded}»`);
  return { matches: reasons.length === 0, reasons };
}
