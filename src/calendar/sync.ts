import { createHash } from "node:crypto";
import type { ChangeRecord } from "../lib/state.js";
import { localParts } from "../lib/time.js";
import { CalendarApi, CalendarEvent, CalendarHttpError, DesiredEvent, EventTime } from "./types.js";

// Writes one source's items into that source's own calendar, without
// duplicates, and never touches an event without the agent's fingerprint.
//  - Event id is deterministic: hash(source + sourceId).
//  - Private extended properties hold source, sourceId, hash and a missing counter.
//  - Same hash: skip. Different: update, report "changed".
//  - Missing from the source on N runs in a row: delete, report "cancelled".
//  - A run that wants to delete more than maxDeletes stops deleting and alerts.

export interface SyncOptions {
  calendarId: string;
  source: DesiredEvent["source"];
  windowStart: string; // ISO
  windowEnd: string; // ISO
  missingRunsBeforeDelete: number;
  maxDeletes: number;
  now?: Date;
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
    ...(d.url ? { source: { title: d.source === "wilma" ? "Wilma" : "MyClub", url: d.url } } : {}),
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
  const now = (opts.now ?? new Date()).toISOString();
  const r: SyncResult = { created: 0, updated: 0, unchanged: 0, deleted: 0, markedMissing: 0, abortedDeletes: 0, changes: [], warnings: [] };
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
      await api.update(opts.calendarId, ev.id, ev);
      r.updated++;
      if (p.hash !== ev.extendedProperties!.private!.hash) change("changed", d.title, d.start);
      continue;
    }
    try {
      await api.insert(opts.calendarId, ev);
      r.created++;
      change("new", d.title, d.start);
    } catch (e) {
      // The id exists outside the window or as a deleted event: bring it back.
      if (e instanceof CalendarHttpError && e.status === 409) {
        await api.update(opts.calendarId, ev.id, ev);
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
  for (const e of gone) {
    const missing = Number(e.extendedProperties?.private?.missing ?? "0") + 1;
    if (missing >= opts.missingRunsBeforeDelete) toDelete.push(e);
    else {
      e.extendedProperties!.private!.missing = String(missing);
      await api.update(opts.calendarId, e.id, e);
      r.markedMissing++;
    }
  }
  if (toDelete.length > opts.maxDeletes) {
    r.abortedDeletes = toDelete.length;
    r.warnings.push(`${opts.source}: run wanted to delete ${toDelete.length} events (limit ${opts.maxDeletes}); stopped, nothing deleted. Check the source.`);
    return r;
  }
  for (const e of toDelete) {
    await api.delete(opts.calendarId, e.id);
    r.deleted++;
    change("cancelled", e.summary ?? "(untitled)", e.start);
  }
  return r;
}

function dedupe(items: DesiredEvent[]): DesiredEvent[] {
  const m = new Map<string, DesiredEvent>();
  for (const d of items) m.set(`${d.source}:${d.sourceId}`, d);
  return [...m.values()];
}
