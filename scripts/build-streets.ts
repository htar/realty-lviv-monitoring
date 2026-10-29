// Builds config/lviv-streets.json from the Ukrainian Wikipedia "Список вулиць Львова (X)" pages.
// A street that crosses several districts is listed in all of them.
// Usage: npm run streets:build
import { writeFileSync } from "node:fs";
import { parseStreetTable, type StreetRecord } from "../src/streets.js";

const API = "https://uk.wikipedia.org/w/api.php";
const HEADERS = { "User-Agent": "realty-monitoring/1.0 (street-to-district dataset builder)" };

async function listPages(): Promise<string[]> {
  const url = `${API}?action=query&list=allpages&apprefix=${encodeURIComponent("Список_вулиць_Львова_(")}&aplimit=100&format=json`;
  const data = await (await fetch(url, { headers: HEADERS })).json() as { query: { allpages: Array<{ title: string }> } };
  return data.query.allpages.map((page) => page.title);
}

async function rawPage(title: string): Promise<string> {
  const url = `https://uk.wikipedia.org/w/index.php?title=${encodeURIComponent(title)}&action=raw`;
  const response = await fetch(url, { headers: HEADERS });
  if (!response.ok) throw new Error(`${title}: HTTP ${response.status}`);
  return response.text();
}

const pages = await listPages();
const streets: StreetRecord[] = [];
for (const title of pages) {
  const rows = parseStreetTable(await rawPage(title));
  console.log(`${title}: ${rows.length}`);
  streets.push(...rows);
  await new Promise((r) => setTimeout(r, 300)); // be polite to Wikipedia
}
streets.sort((a, b) => a.name.localeCompare(b.name, "uk"));
writeFileSync("config/lviv-streets.json", JSON.stringify({
  source: "https://uk.wikipedia.org/wiki/Список_вулиць_Львова (CC BY-SA 4.0)",
  generatedAt: new Date().toISOString().slice(0, 10),
  streets
}, null, 1) + "\n");
console.log(`Saved ${streets.length} streets, ${streets.filter((s) => s.districts.length > 1).length} cross several districts`);
