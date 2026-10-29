import type { Logger } from "pino";
import { matchesSearch } from "./parser.js";
import { fetchRates, siteSearches, toListing, type Rates, type SiteListing } from "./sites.js";
import type { Store } from "./database.js";
import type { TelegramBot } from "./bot.js";
import type { SearchConfig } from "./types.js";

interface Deps {
  config: SearchConfig;
  store: Store;
  bot: Pick<TelegramBot, "sendListing">;
  logger: Pick<Logger, "info" | "warn" | "error">;
  fetchHtml?: (url: string, headers?: Record<string, string>) => Promise<string>;
  getRates?: () => Promise<Rates>;
}

const defaultFetch = async (url: string, headers: Record<string, string> = {}) => {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml", "Accept-Language": "uk-UA,uk;q=0.9", ...headers
    },
    signal: AbortSignal.timeout(30_000)
  });
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return res.text();
};

/** One pass over all sites: fetch, filter, store, notify. A failing site doesn't stop the others. */
export async function pollSites({ config, store, bot, logger, fetchHtml = defaultFetch, getRates = fetchRates }: Deps): Promise<{ seen: number; notified: number }> {
  let rates: Rates;
  try { rates = await getRates(); }
  catch (error) { logger.warn({ err: error }, "NBU rates unavailable, non-UAH prices will be skipped"); rates = { UAH: 1, USD: NaN, EUR: NaN }; }
  let seen = 0, notified = 0;
  for (const search of siteSearches(config)) {
    let cards: SiteListing[];
    try { cards = search.parse(await fetchHtml(search.url, search.headers)); }
    catch (error) { logger.error({ err: error, source: search.source }, "site scrape failed"); continue; }
    if (cards.length === 0) logger.warn({ source: search.source }, "site returned 0 listings, layout may have changed");
    seen += cards.length;
    for (const card of cards) {
      const { incoming, listing } = toListing(card, config, rates);
      if (!Number.isFinite(listing.priceUah)) listing.priceUah = undefined;
      const result = matchesSearch(listing, config);
      const saved = store.save(incoming, listing, result.matches);
      if (!saved.isNewVersion || !result.matches) continue;
      try {
        await bot.sendListing(incoming, listing);
        store.markNotified(saved.key);
        notified += 1;
      } catch (error) { logger.error({ err: error, source: search.source, id: card.id }, "site notification failed"); }
    }
  }
  logger.info({ seen, notified }, "sites polled");
  return { seen, notified };
}

export function startSiteMonitor(deps: Deps, intervalMs: number): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await pollSites(deps); } finally { running = false; }
  };
  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  return () => clearInterval(timer);
}
