export const DEFAULT_TIME_ZONE = "Europe/Kyiv";

export function dateInTimeZone(date: Date, timeZone = DEFAULT_TIME_ZONE): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit"
  }).format(date);
}

export function zonedMidnight(dateText: string, timeZone = DEFAULT_TIME_ZONE): Date {
  const [year, month, day] = dateText.split("-").map(Number);
  if (!year || !month || !day) throw new Error(`Некоректна дата: ${dateText}`);
  const desired = Date.UTC(year, month - 1, day);
  let utc = desired;
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
  });
  for (let i = 0; i < 2; i += 1) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(utc)).map((part) => [part.type, part.value]));
    const represented = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day),
      Number(parts.hour), Number(parts.minute), Number(parts.second));
    utc += desired - represented;
  }
  return new Date(utc);
}

export function addCalendarDays(dateText: string, days: number): string {
  const [year, month, day] = dateText.split("-").map(Number);
  if (!year || !month || !day) throw new Error(`Некоректна дата: ${dateText}`);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}
