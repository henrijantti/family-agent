import { CalendarApi, CalendarEvent, CalendarHttpError, EventTime, ListOptions } from "./types.js";

/** In-memory Google Calendar with the behaviour the sync relies on (409 on a reused id). */
export class FakeCalendar implements CalendarApi {
  calendars = new Map<string, Map<string, CalendarEvent>>();
  calls: string[] = [];

  private cal(id: string) {
    if (!this.calendars.has(id)) this.calendars.set(id, new Map());
    return this.calendars.get(id)!;
  }

  seed(calendarId: string, events: CalendarEvent[]) {
    for (const e of events) this.cal(calendarId).set(e.id, structuredClone(e));
  }

  all(calendarId: string, includeCancelled = false) {
    return [...this.cal(calendarId).values()].filter((e) => includeCancelled || e.status !== "cancelled");
  }

  async list(calendarId: string, opts: ListOptions) {
    this.calls.push(`list ${calendarId}`);
    const [k, v] = opts.privateExtendedProperty?.split("=") ?? [];
    const lo = Date.parse(opts.timeMin);
    const hi = Date.parse(opts.timeMax);
    return this.all(calendarId, opts.showDeleted)
      .filter((e) => !k || e.extendedProperties?.private?.[k] === v)
      .filter((e) => {
        const s = startMs(e.start);
        const en = startMs(e.end);
        return en > lo && s < hi;
      })
      .map((e) => structuredClone(e));
  }

  async insert(calendarId: string, event: CalendarEvent) {
    this.calls.push(`insert ${event.id}`);
    if (this.cal(calendarId).has(event.id)) throw new CalendarHttpError(409, "The requested identifier already exists.");
    this.cal(calendarId).set(event.id, { status: "confirmed", ...structuredClone(event) });
    return event;
  }

  async update(calendarId: string, eventId: string, event: CalendarEvent) {
    this.calls.push(`update ${eventId}`);
    if (!this.cal(calendarId).has(eventId)) throw new CalendarHttpError(404, "Not Found");
    this.cal(calendarId).set(eventId, { status: "confirmed", ...structuredClone(event) });
    return event;
  }

  async delete(calendarId: string, eventId: string) {
    this.calls.push(`delete ${eventId}`);
    const e = this.cal(calendarId).get(eventId);
    if (!e || e.status === "cancelled") throw new CalendarHttpError(410, "Resource has been deleted");
    // Google keeps deleted events as "cancelled"; their ids stay taken.
    e.status = "cancelled";
  }
}

export function startMs(t: EventTime): number {
  return "date" in t ? Date.parse(`${t.date}T00:00:00+02:00`) : Date.parse(t.dateTime);
}
