import { fromLocal } from "./time.js";

// Minimal iCalendar reader: enough for club calendar feeds (single events,
// TZID/UTC/date values, cancellations). Recurring rules are reported, not expanded.

export interface IcsEvent {
  uid: string;
  summary: string;
  start: { date: string } | { dateTime: string };
  end: { date: string } | { dateTime: string };
  location?: string;
  description?: string;
  url?: string;
  cancelled: boolean;
  recurring: boolean;
}

function unescape(v: string) {
  return v.replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1");
}

function parseValue(params: Record<string, string>, v: string): { date: string } | { dateTime: string } {
  if (params.VALUE === "DATE" || /^\d{8}$/.test(v)) return { date: `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}` };
  const m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!m) throw new Error(`Unrecognised ICS date ${v}`);
  const date = `${m[1]}-${m[2]}-${m[3]}`;
  const time = `${m[4]}:${m[5]}`;
  if (m[7] === "Z") return { dateTime: new Date(`${date}T${time}:${m[6]}Z`).toISOString() };
  // Floating or TZID times: club feeds in Finland are Helsinki wall-clock.
  return { dateTime: fromLocal(date, time, params.TZID || "Europe/Helsinki").toISOString() };
}

export function parseIcs(text: string): IcsEvent[] {
  const lines = text.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "").split("\n");
  const out: IcsEvent[] = [];
  let cur: Record<string, { params: Record<string, string>; value: string }> | null = null;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") cur = {};
    else if (line === "END:VEVENT" && cur) {
      const s = cur.DTSTART;
      if (s) {
        const start = parseValue(s.params, s.value);
        const end = cur.DTEND ? parseValue(cur.DTEND.params, cur.DTEND.value) : start;
        out.push({
          uid: cur.UID?.value ?? `${cur.SUMMARY?.value}-${s.value}`,
          summary: unescape(cur.SUMMARY?.value ?? ""),
          start,
          end,
          location: cur.LOCATION ? unescape(cur.LOCATION.value) : undefined,
          description: cur.DESCRIPTION ? unescape(cur.DESCRIPTION.value) : undefined,
          url: cur.URL?.value,
          cancelled: cur.STATUS?.value === "CANCELLED",
          recurring: !!cur.RRULE,
        });
      }
      cur = null;
    } else if (cur) {
      const i = line.indexOf(":");
      if (i < 0) continue;
      const [name, ...ps] = line.slice(0, i).split(";");
      const params = Object.fromEntries(ps.map((p) => p.split("=") as [string, string]));
      cur[name.toUpperCase()] = { params, value: line.slice(i + 1) };
    }
  }
  return out;
}
