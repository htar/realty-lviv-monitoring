import "dotenv/config";
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { SearchConfig } from "./types.js";

const envSchema = z.object({
  TG_API_ID: z.coerce.number().int().positive(),
  TG_API_HASH: z.string().min(1),
  TG_SESSION: z.string().min(1),
  BOT_TOKEN: z.string().min(1),
  BOT_CHAT_ID: z.string().min(1),
  DATABASE_PATH: z.string().default("./data/realty.sqlite"),
  LOG_LEVEL: z.string().default("info"),
  // How often to poll listing sites (rieltor.ua, real-estate.lviv.ua); 0 disables them.
  SITES_INTERVAL_MIN: z.coerce.number().min(0).default(15),
  AUTO_RESCAN_DAYS: z.coerce.number().int().min(1).max(30).default(2),
  RESCAN_INTERVAL_HOURS: z.coerce.number().min(0).default(6)
});

const searchSchema = z.object({
  channels: z.array(z.string().min(1)).min(1).transform((xs) => [...new Set(xs.map((x) => x.replace(/^@/, "")))]),
  filters: z.object({
    dealType: z.literal("rent"),
    propertyTypes: z.array(z.enum(["apartment", "house", "room", "unknown"])),
    city: z.string(),
    districts: z.array(z.string()),
    rooms: z.array(z.number().int().positive()),
    maxPriceUah: z.number().positive(),
    requireExplicitDistrict: z.boolean().default(true),
    excludeKeywords: z.array(z.string()).default([]),
    hideBrokers: z.boolean().default(false),
    districtAliases: z.record(z.string(), z.array(z.string())).optional()
  })
});

export function loadEnv() {
  return envSchema.parse(process.env);
}

export function loadSearchConfig(path = "./config/search.json"): SearchConfig {
  return searchSchema.parse(JSON.parse(readFileSync(path, "utf8"))) as SearchConfig;
}
