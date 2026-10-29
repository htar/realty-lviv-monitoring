import { readFileSync } from "node:fs";

// Street → district lookup for Lviv, built from config/lviv-streets.json (see scripts/build-streets.ts).
// A street that crosses several districts belongs to all of them.

export const LVIV_DISTRICTS = ["Галицький", "Залізничний", "Личаківський", "Сихівський", "Франківський", "Шевченківський"] as const;

export interface StreetRecord {
  name: string;
  type: string;
  districts: string[];
  localities: string[];
  formerNames: string[];
}

export interface LocationMatch {
  /** What was recognised, e.g. "вулиця Замарстинівська" or "Голоско". */
  label: string;
  districts: string[];
  kind: "street" | "locality";
}

// ---------- Wikipedia table parsing ----------

function cleanWiki(value: string): string {
  return value
    .replace(/<ref[^>]*\/>/g, "")
    .replace(/<ref[^>]*>[\s\S]*?<\/ref>/g, "")
    .replace(/<br\s*\/?>/gi, ", ")
    .replace(/\{\{[^{}]*\}\}/g, "")
    .replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, "$1")
    .replace(/'{2,}/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const splitList = (value: string) => value.split(/[,;]/).map((item) => item.trim()).filter(Boolean);

/** Parses one "Список вулиць Львова (X)" page. Disappeared streets (italic names) are skipped. */
export function parseStreetTable(wikitext: string): StreetRecord[] {
  const lines = wikitext.split("\n");
  const headers: string[] = [];
  const records: StreetRecord[] = [];
  for (const line of lines) {
    if (/^!/.test(line)) {
      headers.push(cleanWiki(line.replace(/^!\s*(?:width=\d+\s*\|)?/, "")).toLowerCase());
      continue;
    }
    if (!/^\|[^-}+]/.test(line) || !line.includes("||")) continue;
    const cells = line.slice(1).split("||");
    const column = (title: string) => {
      const index = headers.findIndex((header) => header.startsWith(title));
      return index >= 0 ? cells[index] ?? "" : "";
    };
    const rawName = column("назва").trim();
    if (rawName.startsWith("''")) continue;
    const name = cleanWiki(rawName);
    const districts = splitList(cleanWiki(column("район")))
      .map((item) => item.replace(/\s*район.*$/u, "").trim())
      .filter((item): item is string => (LVIV_DISTRICTS as readonly string[]).includes(item));
    if (!name || districts.length === 0) continue;
    const formerNames = splitList(cleanWiki(column("колишні")))
      .filter((item) => item.split(" ").length <= 3 && !/\d/.test(item) && /^[А-ЯІЇЄҐ]/u.test(item));
    records.push({ name, type: cleanWiki(column("тип")) || "вулиця", districts: [...new Set(districts)],
      localities: splitList(cleanWiki(column("місцевість"))), formerNames });
  }
  return records;
}

// ---------- Text matching ----------

const normalize = (value: string) => value.toLocaleLowerCase("uk-UA").replace(/[’`ʼ]/g, "'").replace(/ё/g, "е");

/**
 * Rough stem for comparing Ukrainian and Russian spellings in any case:
 * "Замарстинівській" = "Замарстинівська", "Сихові" = "Сихів", "Городоцкая" = "Городоцька".
 */
export function stem(word: string): string {
  let w = normalize(word).replace(/[^\p{L}'-]/gu, "");
  if (w.length > 4) {
    w = w.replace(/ів$/u, "ов"); // Сихів → Сихові, Клепарів → Клепарові
    w = w.replace(/(ого|ому|ая|ой|ую|ій|ий|ої|ою|ею|ей|ам|ах|а|я|о|е|у|ю|і|ї|и|й|ь)$/u, "") || w;
  }
  // Fold letters that differ between Ukrainian and Russian spelling.
  return w.replace(/[ь'-]/g, "").replace(/[іїиы]/g, "и").replace(/[єэ]/g, "е");
}

const tokens = (value: string) => normalize(value).split(/[^\p{L}'-]+/u).filter(Boolean).map(stem);

/** Generic localities that would match too much text. */
const LOCALITY_STOPLIST = new Set(["центр", "середмістя", "гори", "ялівець"]);

/** Words after which a street name follows, or before which it ends ("Наукова вулиця"). */
const MARKER = /^(вул|вулиц\p{L}*|ул|улиц\p{L}*|просп\p{L}*|пр-т|пров|провул\p{L}*|пер|переул\p{L}*|пл|площ\p{L}*|бульв\p{L}*|узвіз|тупик)$/u;

/** Street type implied by a marker word, used to tell "вул. Шевченка" from "просп. Шевченка". */
function markerType(marker: string): string | undefined {
  if (/^(вул|ул)/u.test(marker)) return "вулиця";
  if (/^(просп|пр-т)/u.test(marker)) return "проспект";
  if (/^(пров|пер)/u.test(marker)) return "провулок";
  if (/^пл/u.test(marker)) return "площа";
  return undefined;
}

export class StreetIndex {
  private readonly byFirstStem = new Map<string, StreetRecord[]>();
  private readonly byFormerStem = new Map<string, StreetRecord[]>();
  private readonly localities: Array<{ name: string; stems: string[]; districts: string[] }> = [];

  constructor(readonly streets: StreetRecord[]) {
    const localityVotes = new Map<string, Map<string, number>>();
    for (const street of streets) {
      for (const word of tokens(street.name).filter((t) => t.length >= 3)) this.push(this.byFirstStem, word, street);
      for (const former of street.formerNames) {
        const first = tokens(former)[0];
        if (first && first.length >= 4) this.push(this.byFormerStem, first, street);
      }
      for (const locality of street.localities) {
        const votes = localityVotes.get(locality) ?? new Map<string, number>();
        for (const district of street.districts) votes.set(district, (votes.get(district) ?? 0) + 1);
        localityVotes.set(locality, votes);
      }
    }
    for (const [name, votes] of localityVotes) {
      const stems = tokens(name);
      if (stems.join(" ").length < 5 || LOCALITY_STOPLIST.has(normalize(name))) continue;
      const total = [...votes.values()].reduce((a, b) => a + b, 0);
      // A locality belongs to every district holding at least a quarter of its streets.
      const districts = [...votes].filter(([, count]) => count / total >= 0.25).map(([district]) => district);
      this.localities.push({ name, stems, districts });
    }
  }

  private push(map: Map<string, StreetRecord[]>, key: string, street: StreetRecord): void {
    const list = map.get(key) ?? [];
    if (!list.includes(street)) list.push(street);
    map.set(key, list);
  }

  static load(path = new URL("../config/lviv-streets.json", import.meta.url)): StreetIndex {
    const data = JSON.parse(readFileSync(path, "utf8")) as { streets: StreetRecord[] };
    return new StreetIndex(data.streets);
  }

  /** Finds streets (next to a marker like "вул.") and localities mentioned in the text. */
  find(text: string): LocationMatch[] {
    const words = normalize(text).split(/[^\p{L}'-]+/u).filter(Boolean);
    const stems = words.map(stem);
    const matches: LocationMatch[] = [];
    const seen = new Set<string>();
    const add = (match: LocationMatch) => {
      if (seen.has(match.label)) return;
      seen.add(match.label);
      matches.push(match);
    };

    for (let i = 0; i < words.length; i += 1) {
      if (!MARKER.test(words[i]!)) continue;
      // The name is usually right after the marker ("вул. Наукова") or right before it ("Наукова вулиця").
      const candidates = [stems.slice(i + 1, i + 4), stems.slice(Math.max(0, i - 2), i).reverse()];
      for (const window of candidates) {
        const street = this.lookup(window, markerType(words[i]!));
        if (street) { add(street); break; }
      }
    }

    for (const locality of this.localities) {
      for (let i = 0; i + locality.stems.length <= stems.length; i += 1) {
        if (locality.stems.every((s, k) => stems[i + k] === s)) {
          add({ label: locality.name, districts: locality.districts, kind: "locality" });
          break;
        }
      }
    }
    return matches;
  }

  private lookup(window: string[], type?: string): LocationMatch | undefined {
    for (const map of [this.byFirstStem, this.byFormerStem]) {
      for (const word of window) {
        const streets = map.get(word);
        if (!streets?.length) continue;
        // Prefer the street type named by the marker, then streets whose other name words also appear.
        const score = (s: StreetRecord) => (s.type === type ? 10 : 0) + tokens(s.name).filter((t) => window.includes(t)).length;
        const best = Math.max(...streets.map(score));
        const chosen = streets.filter((s) => score(s) === best);
        const districts = [...new Set(chosen.flatMap((s) => s.districts))].sort();
        return { label: `${chosen[0]!.type} ${chosen[0]!.name}`, districts, kind: "street" };
      }
    }
    return undefined;
  }
}

let defaultIndex: StreetIndex | undefined | null;

/** Lazily loads the bundled dataset; returns undefined if it is missing. */
export function defaultStreetIndex(): StreetIndex | undefined {
  if (defaultIndex === undefined) {
    try { defaultIndex = StreetIndex.load(); } catch { defaultIndex = null; }
  }
  return defaultIndex ?? undefined;
}
