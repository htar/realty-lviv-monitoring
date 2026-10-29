import { readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

// Prevents two bot instances (Telegram returns 409 Conflict when two poll the same token).
export function acquireInstanceLock(path: string): () => void {
  const file = resolve(path);
  mkdirSync(dirname(file), { recursive: true });
  let existing = NaN;
  try { existing = Number(readFileSync(file, "utf8").trim()); } catch { /* no lock yet */ }
  if (Number.isInteger(existing) && existing !== process.pid && isAlive(existing)) {
    throw new Error(`Бот уже запущено (PID ${existing}). Зупиніть його: taskkill /PID ${existing} /T /F`);
  }
  writeFileSync(file, String(process.pid));
  return () => {
    try { if (Number(readFileSync(file, "utf8").trim()) === process.pid) rmSync(file); } catch { /* already gone */ }
  };
}
