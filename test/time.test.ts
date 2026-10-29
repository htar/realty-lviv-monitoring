import test from "node:test";
import assert from "node:assert/strict";
import { addCalendarDays, dateInTimeZone, zonedMidnight } from "../src/time.js";

test("formats a date in Kyiv", () => {
  assert.equal(dateInTimeZone(new Date("2026-10-28T23:30:00Z")), "2026-10-29");
});

test("converts Kyiv midnight with winter offset", () => {
  assert.equal(zonedMidnight("2026-10-29").toISOString(), "2026-10-28T22:00:00.000Z");
});

test("converts Kyiv midnight with summer offset", () => {
  assert.equal(zonedMidnight("2026-07-10").toISOString(), "2026-07-09T21:00:00.000Z");
});

test("adds calendar days across month and year boundaries", () => {
  assert.equal(addCalendarDays("2026-10-31", 1), "2026-11-01");
  assert.equal(addCalendarDays("2026-01-01", -1), "2025-12-31");
});

test("rejects malformed dates", () => {
  assert.throws(() => zonedMidnight("bad"), /Некоректна дата/);
  assert.throws(() => addCalendarDays("bad", 1), /Некоректна дата/);
});
