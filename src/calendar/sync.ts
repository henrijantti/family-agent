import { createHash } from "node:crypto";
import type { ChangeRecord } from "../lib/state.js";
import { localParts } from "../lib/time.js";
import { CalendarApi, CalendarEvent, CalendarHttpError, DesiredEvent, EventTime } from "./types.js";

// Writes one source's items into that source's own calendar, without
// duplicates, and never touches an event without the agent's fingerprint.
//  - Event id is deterministic: hash(source + sourceId).
//  - Private extended properties hold source, sourceId, hash and a missing counter.
//  - Same hash: skip. Different: update, report "changed".
//  - Missing from the source on N runs in a row AND for at least H hours:
//    delete, report "cancelled". Counting runs alone let forced runs during a
//    deploy burn the grace in minutes (2026-10-25: a parser bug deleted a real
//    School event), so the clock starts at the first missing run (missingSince).
//  - A run that wants to delete more than maxDeletes stops deleting and alerts.
//  - dryRun computes the same result without writing anything.

export interface SyncOptions {
  calendarId: string;
  source: DesiredEvent["source"];
  windowStart: string; // ISO
  windowEnd: string; // ISO
  missingRunsBeforeDelete: number;
  /** Hours an event must have been missing before it is deleted (0: runs only). */
  missingHoursBeforeDelete?: number;
  maxDeletes: number;
  now?: Date;
  dryRun?: boolean;
}

export interface SyncResult {
  created: number;
  updated: number;
  unchanged: number;
  deleted: number;
  markedMissing: number;
  abortedDeletes: number;
  changes: ChangeRecord[];
  warnings: string[];
  /** Titles and times of the events this run deleted, or would delete when dryRun. */
  deletions: string[];
  /** Titles and times of the events marked missing (not deleted yet). */
  missing: string[];
}

export function eventId(source: string, sourceId: string): string {
  // Google ids: base32hex chars, 5-1024 long. Hex digits are a subset.
  return "fa" + createHash("sha1").update(`${source}:${sourceId}`).digest("hex");
}

export function hashOf(d: DesiredEvent): string {
  const fields = [d.title, d.start, d.end, d.location ?? "", d.description ?? "", d.url ?? "", !!d.tentative, d.reminderMinutes ?? null];
  return createHash("sha1").update(JSON.stringify(fields)).digest("hex").slice(0, 16);
}

export function toCalendarEvent(d: DesiredEvent, missing = 0): CalendarEvent {
  const description = [d.description, d.url ? `Source: ${d.url}` : "", "Added by the family agent. Edits here are overwritten; add notes on the main family calendar."]
    .filter(Boolean)
    .join("\n\n");
  return {
    id: eventId(d.source, d.sourceId),
    summary: d.title,
    description,
    location: d.location,
    start: d.start,
    end: d.end,
    status: d.tentative ? "tentative" : "confirmed",
    transparency: "opaque",
    reminders: d.reminderMinutes != null ? { useDefault: false, overrides: [{ method: "popup", minutes: d.reminderMinutes }] } : { useDefault: false },
    extendedProperties: {
      private: { agent: "family-agent", source: d.source, sourceId: d.sourceId, hash: hashOf(d), missing: String(missing) },
    },
    ...(d.url ? { source: { title: d.source === "wilma" ? "Wilma" : d.source === "feed" ? "Tulospalvelu" : "MyClub", url: d.url } } : {}),
  };
}

export function describeWhen(t: EventTime): string {
  if ("date" in t) return t.date;
  // Google returns times in the calendar's own offset; show Helsinki time.
  if (/(Z|[+-]\d\d:\d\d)$/.test(t.dateTime)) {
    const p = localParts(new Date(t.dateTime));
    return `${p.date} ${p.time}`;
  }
  return t.dateTime.slice(0, 16).replace("T", " ");
}

export async function syncSource(api: CalendarApi, desired: DesiredEvent[], opts: SyncOptions): Promise<SyncResult> {
  const nowDate = opts.now ?? new Date();
  const now = nowDate.toISOString();
  const r: SyncResult = { created: 0, updated: 0, unchanged: 0, deleted: 0, markedMissing: 0, abortedDeletes: 0, changes: [], warnings: [], deletions: [], missing: [] };
  const write = opts.dryRun
    ? { insert: async () => {}, update: async () => {}, delete: async () => {} }
    : { insert: (c: string, e: CalendarEvent) => api.insert(c, e), update: (c: string, id: string, e: CalendarEvent) => api.update(c, id, e), delete: (c: string, id: string) => api.delete(c, id) };
  const change = (kind: ChangeRecord["kind"], title: string, when: EventTime) =>
    r.changes.push({ at: now, source: opts.source, kind, title, when: describeWhen(when) });

  const existing = (
    await api.list(opts.calendarId, {
      timeMin: opts.windowStart,
      timeMax: opts.windowEnd,
      privateExtendedProperty: `source=${opts.source}`,
    })
  ).filter((e) => e.extendedProperties?.private?.agent === "family-agent" && e.status !== "cancelled");
  const byId = new Map(existing.map((e) => [e.id, e]));

  const seen = new Set<string>();
  for (const d of dedupe(desired)) {
    const ev = toCalendarEvent(d);
    seen.add(ev.id);
    const cur = byId.get(ev.id);
    if (cur) {
      const p = cur.extendedProperties?.private ?? {};
      if (p.hash === ev.extendedProperties!.private!.hash && p.missing === "0") {
        r.unchanged++;
        continue;
      }
      await write.update(opts.calendarId, ev.id, ev);
      r.updated++;
      if (p.hash !== ev.extendedProperties!.private!.hash) change("changed", d.title, d.start);
      continue;
    }
    try {
      await write.insert(opts.calendarId, ev);
      r.created++;
      change("new", d.title, d.start);
    } catch (e) {
      // The id exists outside the window or as a deleted event: bring it back.
      if (e instanceof CalendarHttpError && e.status === 409) {
        await write.update(opts.calendarId, ev.id, ev);
        r.updated++;
      } else throw e;
    }
  }

  const gone = existing.filter((e) => !seen.has(e.id));
  if (desired.length === 0 && gone.length > 0) {
    r.warnings.push(`${opts.source} returned no items but the calendar has ${gone.length}; treating as a failed read, nothing removed`);
    return r;
  }
  const toDelete: CalendarEvent[] = [];
  const graceMs = (opts.missingHoursBeforeDelete ?? 0) * 3600_000;
  for (const e of gone) {
    const p = e.extendedProperties!.private!;
    const missing = Number(p.missing ?? "0") + 1;
    // Events marked before missingSince existed start their clock now.
    const since = p.missingSince && missing > 1 ? p.missingSince : now;
    if (missing >= opts.missingRunsBeforeDelete && nowDate.getTime() - Date.parse(since) >= graceMs) toDelete.push(e);
    else {
      p.missing = String(missing);
      p.missingSince = since;
      await write.update(opts.calendarId, e.id, e);
      r.markedMissing++;
      r.missing.push(`${e.summary ?? "(untitled)"} ${describeWhen(e.start)}`);
    }
  }
  if (toDelete.length > opts.maxDeletes) {
    r.abortedDeletes = toDelete.length;
    r.warnings.push(`${opts.source}: run wanted to delete ${toDelete.length} events (limit ${opts.maxDeletes}); stopped, nothing deleted. Check the source.`);
    return r;
  }
  for (const e of toDelete) {
    await write.delete(opts.calendarId, e.id);
    r.deleted++;
    r.deletions.push(`${e.summary ?? "(untitled)"} ${describeWhen(e.start)}`);
    change("cancelled", e.summary ?? "(untitled)", e.start);
  }
  return r;
}

function dedupe(items: DesiredEvent[]): DesiredEvent[] {
  const m = new Map<string, DesiredEvent>();
  for (const d of items) m.set(`${d.source}:${d.sourceId}`, d);
  return [...m.values()];
}
