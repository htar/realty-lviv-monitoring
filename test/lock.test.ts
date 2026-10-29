import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireInstanceLock } from "../src/lock.js";

test("instance lock blocks a live owner and replaces a stale one", () => {
  const dir = mkdtempSync(join(tmpdir(), "realty-lock-"));
  const file = join(dir, "radar.lock");
  try {
    writeFileSync(file, String(process.ppid));
    assert.throws(() => acquireInstanceLock(file), /уже запущено/);
    writeFileSync(file, "999999999");
    const release = acquireInstanceLock(file);
    assert.ok(existsSync(file));
    release();
    assert.ok(!existsSync(file));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
