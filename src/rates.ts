// Exchange rates used to convert USD/EUR rent prices to UAH.
// Fallback values are used until the first successful NBU fetch.
const rates = { USD: 41.5, EUR: 48 };

export function getRate(currency: "USD" | "EUR"): number { return rates[currency]; }

export function setRates(next: Partial<typeof rates>): void {
  for (const key of ["USD", "EUR"] as const) {
    const value = next[key];
    if (typeof value === "number" && value > 0) rates[key] = value;
  }
}

/** Loads official rates from the National Bank of Ukraine. Returns false on failure. */
export async function refreshRates(fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const response = await fetchImpl("https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?json",
      { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) return false;
    const data = await response.json() as Array<{ cc: string; rate: number }>;
    const find = (cc: string) => data.find((row) => row.cc === cc)?.rate;
    setRates({ USD: find("USD"), EUR: find("EUR") });
    return true;
  } catch {
    return false;
  }
}
