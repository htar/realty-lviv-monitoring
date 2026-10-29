import * as cheerio from "cheerio";
import type { IncomingMessage, Listing, SearchConfig } from "./types.js";

// Listing sites ported from real-estate-aggregator (scripts/scrape).
// Only sites whose search pages are plain server-rendered HTML and allowed by robots.txt.
// OLX (WAF blocks plain GETs) and DOM.RIA (robots.txt opt-out) are intentionally not scraped.

export type SiteId = "rieltor" | "real-estate-lviv";
type Currency = "UAH" | "USD" | "EUR";
export type Rates = Record<Currency, number>;

export interface SiteListing {
  source: SiteId;
  id: string;
  url: string;
  title: string;
  price: number;
  currency: Currency;
  rooms: number;
  floor: number | null;
  totalFloors: number | null;
  area: number | null;
  city: string;
  district: string | null;
  address: string;
}

export const SITE_NAMES: Record<SiteId, string> = { rieltor: "rieltor.ua", "real-estate-lviv": "real-estate.lviv.ua" };

const clean = (s: string) => s.replace(/\s+/g, " ").trim();
const stripSettlementPrefix = (name: string) => name.replace(/^(с\.|смт\.?|м\.)\s*/iu, "").trim();

export function parseRieltor(html: string): SiteListing[] {
  const $ = cheerio.load(html);
  const listings: SiteListing[] = [];
  $('[data-jss="catalog-item"]').each((_, el) => {
    const card = $(el);
    const id = card.attr("data-catalog-item-id");
    const url = card.find("a.catalog-card-media").first().attr("href");
    const priceText = clean(card.find(".catalog-card-price-title").first().text());
    const price = Number(/([\d\s]+)/.exec(priceText)?.[1]?.replace(/\s/g, "") ?? NaN);
    let rooms: number | null = null, area: number | null = null, floor: number | null = null, totalFloors: number | null = null;
    card.find(".catalog-card-details-row").each((__, row) => {
      const text = clean($(row).text());
      const r = /^(\d+)\s*кімнат/.exec(text); if (r) rooms = Number(r[1]);
      const a = /^(\d+(?:[.,]\d+)?)(?:\s*\/[\d.,\s/]*)?\s*м²/.exec(text); if (a) area = Number((a[1] ?? "").replace(",", "."));
      const f = /поверх\s*(\d+)\s*з\s*(\d+)/.exec(text);
      if (f) { floor = Number(f[1]); totalFloors = Number(f[2]); }
    });
    if (!id || !url || !price || !rooms) return;
    // "Львів , Шевченківський р-н" or "с. Зимна Вода"
    const region = clean(card.find(".catalog-card-region").text()).split(",").map((p) => p.trim()).filter(Boolean);
    const city = stripSettlementPrefix(region[0] || "Львів");
    const district = region[1] ? region[1].replace(/\s*р-н\.?$/i, "") : null;
    const address = clean(card.find(".catalog-card-address").first().text()) || city;
    listings.push({
      source: "rieltor", id, url, title: `Оренда, ${address}`, price,
      currency: priceText.includes("$") ? "USD" : priceText.includes("€") ? "EUR" : "UAH",
      rooms, floor, totalFloors, area, city, district, address
    });
  });
  return listings;
}

export function parseRealEstateLviv(html: string): SiteListing[] {
  const $ = cheerio.load(html);
  const listings: SiteListing[] = [];
  // The wrapper class isn't one-per-card, so take each ad link and climb to the
  // largest ancestor that still holds only that one ad.
  $("a.photo-obj-search-page").each((_, el) => {
    let card = $(el);
    while (card.parent().length && card.parent().find("a.photo-obj-search-page").length === 1) card = card.parent();
    const href = $(el).attr("href");
    const id = href ? /^\/(\d+)-/.exec(href)?.[1] : undefined;
    if (!href || !id) return;
    const priceText = clean(card.find(".object-listing-price").eq(0).text());
    const price = Number(/([\d\s]+)/.exec(priceText)?.[1]?.replace(/\s/g, "") ?? NaN);
    const details = clean(card.find(".object-listing-price").eq(1).text());
    const rooms = Number(/(\d+)\s*кімн/.exec(details)?.[1] ?? NaN);
    const areaMatch = /(\d+)(?:\s*\/\s*\d+)?\s*кв\.?м/.exec(details);
    const floorOf = /(\d+)\s*\/\s*(\d+)\s*пов/.exec(details);
    const addressFull = clean(card.find(".object-listing-address").text());
    if (!price || !rooms || !addressFull) return;
    // "Вулиця, 22, Львів, Шевченківський район" or "с. Зимна Вода, Пустомитівський район"
    const parts = addressFull.split(",").map((p) => p.trim()).filter(Boolean);
    const dIdx = parts.findIndex((p) => /район$/.test(p));
    let city = "Львів", district: string | null = null;
    if (dIdx !== -1) {
      district = /([А-ЯІЇЄҐ][а-яіїєґ'-]+)\s+район$/.exec(parts[dIdx] ?? "")?.[1] ?? null;
      city = (dIdx > 0 ? parts[dIdx - 1] : parts[0]) ?? city;
    } else city = parts[parts.length - 1] ?? city;
    city = stripSettlementPrefix(city);
    const address = parts.filter((p, i) => i !== dIdx && p !== city).join(", ") || city;
    const title = clean(card.find(".object-listing-text").first().text());
    listings.push({
      source: "real-estate-lviv", id, url: new URL(href, "https://www.real-estate.lviv.ua").toString(),
      title: title || `Оренда, ${address}`, price,
      currency: /грн/i.test(priceText) ? "UAH" : /євро|€/i.test(priceText) ? "EUR" : "USD",
      rooms, floor: floorOf ? Number(floorOf[1]) : null, totalFloors: floorOf ? Number(floorOf[2]) : null,
      area: areaMatch ? Number(areaMatch[1]) : null, city, district, address
    });
  });
  return listings;
}

/** Apartments only: the bot's search is about flats, and houses would be filtered out anyway. */
export function siteSearches(config: SearchConfig): Array<{ source: SiteId; url: string; parse: (html: string) => SiteListing[]; headers?: Record<string, string> }> {
  const max = Math.round(config.filters.maxPriceUah);
  return [
    { source: "rieltor", url: `https://rieltor.ua/lvov/flats-rent/?price_max=${max}`, parse: parseRieltor },
    {
      source: "real-estate-lviv",
      url: "https://www.real-estate.lviv.ua/" + encodeURI(`оренда-квартир/місто-львів/ціна-0,${max}/c-uah`),
      parse: parseRealEstateLviv,
      // The site 403s requests without a Referer.
      headers: { Referer: "https://www.real-estate.lviv.ua/" }
    }
  ];
}

/** Official NBU rates, UAH per unit. */
export async function fetchRates(): Promise<Rates> {
  const rate = async (code: string) => {
    const res = await fetch(`https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?valcode=${code}&json`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`NBU ${code} -> HTTP ${res.status}`);
    const [entry] = await res.json() as Array<{ rate?: number }>;
    if (!entry?.rate) throw new Error(`NBU ${code}: no rate`);
    return entry.rate;
  };
  const [USD, EUR] = await Promise.all([rate("USD"), rate("EUR")]);
  return { UAH: 1, USD, EUR };
}

const normalize = (s: string) => s.toLowerCase().replace(/[’'`ʼ]/g, "");

/** Maps a site card onto the same Listing/IncomingMessage shape Telegram posts use, so filters, storage and notifications are shared. */
export function toListing(site: SiteListing, config: SearchConfig, rates: Rates): { incoming: IncomingMessage; listing: Listing } {
  const priceUah = Math.round(site.price * rates[site.currency]);
  const district = config.filters.districts.find((d) => site.district && normalize(d) === normalize(site.district));
  const city = normalize(site.city) === normalize(config.filters.city) ? config.filters.city : site.city;
  const priceShown = site.currency === "UAH" ? `${site.price} грн` : `${site.price} ${site.currency} (≈${priceUah} грн)`;
  const text = [
    site.title,
    `${site.rooms} кімн.${site.area ? ` · ${site.area} м²` : ""}${site.floor ? ` · поверх ${site.floor}${site.totalFloors ? `/${site.totalFloors}` : ""}` : ""}`,
    `${site.address}${site.district ? `, ${site.district} р-н` : ""}`,
    priceShown
  ].join("\n");
  return {
    incoming: {
      channel: SITE_NAMES[site.source], channelId: `site:${site.source}`, messageId: Number(site.id),
      text, date: new Date(), link: site.url, edited: false
    },
    listing: {
      dealType: "rent", propertyType: "apartment", city, district, rooms: site.rooms, priceUah,
      currency: site.currency, isLikelyBroker: false, isDemandPost: false, text
    }
  };
}
