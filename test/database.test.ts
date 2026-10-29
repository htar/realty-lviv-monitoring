import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/database.js";
import type { SearchConfig } from "../src/types.js";

test("persists filter changes", () => {
  const directory = mkdtempSync(join(tmpdir(), "realty-monitoring-"));
  try {
    const path = join(directory, "test.sqlite");
    const filters: SearchConfig["filters"] = {
      dealType: "rent", propertyTypes: ["apartment"], city: "Львів",
      districts: ["Шевченківський", "Франківський"], rooms: [1, 2],
      maxPriceUah: 24000, requireExplicitDistrict: false
    };
    const store = new Store(path);
    store.saveFilters(filters);
    assert.deepEqual(store.loadFilters(), filters);
    store.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("persists active channels", () => {
  const directory = mkdtempSync(join(tmpdir(), "realty-monitoring-"));
  try {
    const store = new Store(join(directory, "test.sqlite"));
    store.saveChannels(["direct_rent", "lviv_no_maklers"]);
    assert.deepEqual(store.loadChannels(), ["direct_rent", "lviv_no_maklers"]);
    store.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
