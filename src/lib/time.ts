// Helsinki wall-clock helpers. Everything the agent schedules or writes is in
// Europe/Helsinki, never UTC, so daylight saving can't shift an event.
export const TZ = "Europe/Helsinki";

export const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type Day = (typeof DAYS)[number];

export interface LocalParts {
  date: string; // YYYY-MM-DD
  time: string; // HH:MM
  day: Day;
  minutes: number; // minutes since local midnight
}

export function localParts(at: Date, tz = TZ): LocalParts {
  const f = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  });
  const p = Object.fromEntries(f.formatToParts(at).map((x) => [x.type, x.value]));
  const time = `${p.hour}:${p.minute}`;
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    time,
    day: p.weekday.toLowerCase().slice(0, 3) as Day,
    minutes: toMinutes(time),
  };
}

export function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/** UTC offset of the zone at an instant, as "+03:00". */
export function offsetAt(at: Date, tz = TZ): string {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" });
  const name = f.formatToParts(at).find((x) => x.type === "timeZoneName")?.value ?? "GMT";
  const m = name.match(/GMT([+-]\d{2}):?(\d{2})?/);
  return m ? `${m[1]}:${m[2] ?? "00"}` : "+00:00";
}

/** Helsinki wall-clock date + time to an absolute Date (correct across DST). */
export function fromLocal(date: string, time = "00:00", tz = TZ): Date {
  // Guess with the offset at noon that day, then correct once.
  const guess = new Date(`${date}T${time}:00${offsetAt(new Date(`${date}T12:00:00Z`), tz)}`);
  const fixed = new Date(`${date}T${time}:00${offsetAt(guess, tz)}`);
  return fixed;
}

/** "2026-10-21T08:30:00+03:00" */
export function localIso(date: string, time: string, tz = TZ): string {
  const d = fromLocal(date, time, tz);
  return `${date}T${time}:00${offsetAt(d, tz)}`;
}

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function dayOf(date: string): Day {
  return DAYS[new Date(`${date}T12:00:00Z`).getUTCDay()];
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86400000);
}

/** Is local time inside [from, to) where the range may wrap midnight. */
export function inRange(minutes: number, from: string, to: string): boolean {
  const a = toMinutes(from);
  const b = toMinutes(to);
  return a <= b ? minutes >= a && minutes < b : minutes >= a || minutes < b;
}
