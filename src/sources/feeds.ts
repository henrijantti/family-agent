import type { DesiredEvent } from "../calendar/types.js";
import type { Config } from "../config.js";
import { parseIcs } from "../lib/ics.js";
import { addDays, localParts } from "../lib/time.js";

// Public calendar feeds (ICS) into a calendar: Henri's floorball team PKT from
// the results service's own "subscribe" link (2026-10-26). All feeds share the
// sync source "feed", so they are synced together per calendar, and each
// item's id carries its feed's name.

export type Feed = NonNullable<Config["feeds"]>["list"][number];

export function feedEvents(feed: Feed, ics: string, cfg: Config, now: Date): DesiredEvent[] {
  const today = localParts(now).date;
  const horizon = addDays(today, cfg.feeds?.horizon_days ?? 180);
  return parseIcs(ics)
    .filter((e) => {
      const d = "date" in e.start ? e.start.date : localParts(new Date(e.start.dateTime)).date;
      return d >= today && d <= horizon;
    })
    .map((e) => ({
      source: "feed" as const,
      sourceId: `${feed.name}:${e.uid}`,
      title: `${e.cancelled ? "CANCELLED: " : ""}${feed.who}: ${e.summary}`,
      start: "date" in e.start ? e.start : { ...e.start, timeZone: cfg.timezone },
      end: "date" in e.end ? e.end : { ...e.end, timeZone: cfg.timezone },
      location: e.location,
      url: e.url,
    }));
}

export async function fetchFeed(feed: Feed): Promise<string> {
  const res = await fetch(feed.url.replace(/^webcal:/, "https:"));
  if (!res.ok) throw new Error(`${feed.name} feed ${res.status}`);
  const text = await res.text();
  if (!text.includes("BEGIN:VCALENDAR")) throw new Error(`${feed.name} feed is not a calendar`);
  return text;
}
