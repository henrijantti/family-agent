import { randomBytes } from "node:crypto";
import { Config } from "../config.js";
import { CalendarApi, CalendarEvent, EventTime } from "../calendar/types.js";
import { buildDigest, conflicts, mergeCrossCalendar, splitTitle } from "../digest/build.js";
import { billsToRemind } from "../sources/outlook.js";
import { feesDue, MyClubSnapshot, openSignups } from "../sources/myclub.js";
import { calId, collectHub, Ctx } from "../jobs.js";
import { StateData } from "../lib/state.js";
import { addDays, daysBetween, localIso, localParts } from "../lib/time.js";
import { weekPlan } from "../digest/week-plan.js";
import { Tool, ToolError } from "./mcp.js";

// Tools for the chat front door. Reads cover all three calendars and the bill
// list; writes reach only the School and Hobbies calendars, and only events
// this chat created (tag below). The sync never touches those: it acts only on
// events tagged "family-agent", so a chat event can't be deleted by a sync run.
// State is read fresh on every call and never saved: the 15-minute tick owns it.

export const CHAT_TAG = "family-agent-chat";
const DATE = "^\\d{4}-\\d{2}-\\d{2}$";
const TIME = "^([01]\\d|2[0-3]):[0-5]\\d$";
const MAX_LIST_DAYS = 62;

export interface FamilyDeps {
  cfg: Config;
  calendar?: CalendarApi;
  /** A fresh copy of the agent's state (read-only use). */
  loadState(): StateData;
  now(): Date;
  /** The family-group agent's copy: no bills (they are Henri's, from his Outlook). */
  group?: boolean;
  /** The mail desk's file: bills the Email agent reported go into Henri's week plan. */
  deskFile?: string;
}

type Writable = "school" | "hobbies";

function writableId(d: FamilyDeps, which: Writable): string {
  const id = calId(d.cfg, which);
  if (!id) throw new ToolError(`the ${which} calendar is not configured`);
  return id;
}

function cal(d: FamilyDeps): CalendarApi {
  if (!d.calendar) throw new ToolError("Google calendar is not configured");
  return d.calendar;
}

function ctx(d: FamilyDeps): Ctx {
  return { cfg: d.cfg, state: d.loadState(), now: d.now(), calendar: d.calendar, log: () => {} };
}

function when(t: EventTime): string {
  return "date" in t ? t.date : t.dateTime;
}

/** Start/end for an all-day or timed event in Helsinki time. */
export function eventTimes(date: string, start?: string, end?: string, endDate?: string): { start: EventTime; end: EventTime } {
  if (endDate && daysBetween(date, endDate) < 0) throw new ToolError("endDate is before date");
  if (!start) {
    if (end) throw new ToolError("end needs a start time");
    return { start: { date }, end: { date: addDays(endDate ?? date, 1) } };
  }
  const endTime = end ?? addMinutes(start, 60);
  const lastDay = endDate ?? (endTime <= start ? addDays(date, 1) : date);
  return {
    start: { dateTime: localIso(date, start), timeZone: "Europe/Helsinki" },
    end: { dateTime: localIso(lastDay, endTime), timeZone: "Europe/Helsinki" },
  };
}

function addMinutes(hhmm: string, n: number): string {
  const m = (Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3)) + n) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** New times for an update: fields not given keep their current value, and a moved start keeps the duration. */
export function updatedTimes(ev: CalendarEvent, a: { date?: string; start?: string; end?: string; endDate?: string }) {
  const allDay = "date" in ev.start;
  const curDate = allDay ? (ev.start as { date: string }).date : localParts(new Date((ev.start as { dateTime: string }).dateTime)).date;
  const date = a.date ?? curDate;
  if (allDay && !a.start) {
    if (a.end) throw new ToolError("end needs a start time");
    const span = daysBetween(curDate, (ev.end as { date: string }).date) - 1;
    return eventTimes(date, undefined, undefined, a.endDate ?? addDays(date, Math.max(span, 0)));
  }
  const curStart = allDay ? undefined : new Date((ev.start as { dateTime: string }).dateTime);
  const start = a.start ?? localParts(curStart!).time;
  if (a.end || a.endDate) return eventTimes(date, start, a.end ?? (curStart ? localParts(new Date((ev.end as { dateTime: string }).dateTime)).time : undefined), a.endDate);
  const minutes = curStart ? (Date.parse((ev.end as { dateTime: string }).dateTime) - curStart.getTime()) / 60_000 : 60;
  const endAt = localParts(new Date(Date.parse(localIso(date, start)) + minutes * 60_000));
  return eventTimes(date, start, endAt.time, endAt.date);
}

async function ownEvent(d: FamilyDeps, which: Writable, id: string): Promise<{ calendarId: string; ev: CalendarEvent }> {
  const calendarId = writableId(d, which);
  const today = localParts(d.now()).date;
  // Look up by tag rather than by id alone, so the agent can't edit a synced or human event.
  const evs = await cal(d).list(calendarId, {
    timeMin: localIso(addDays(today, -400), "00:00"),
    timeMax: localIso(addDays(today, 800), "00:00"),
    privateExtendedProperty: `agent=${CHAT_TAG}`,
  });
  const ev = evs.find((e) => e.id === id && e.status !== "cancelled");
  if (!ev) throw new ToolError(`no event ${id} that this chat added on the ${which} calendar`);
  return { calendarId, ev };
}

const calendarProp = { type: "string" as const, enum: ["school", "hobbies"], description: "school = school/Wilma things, hobbies = sports and clubs" };
const fields = {
  title: { type: "string" as const, maxLength: 200, description: 'Finnish, child first, e.g. "Oskar: hammaslääkäri"' },
  date: { type: "string" as const, pattern: DATE, description: "YYYY-MM-DD" },
  start: { type: "string" as const, pattern: TIME, description: "HH:MM Helsinki time; leave out for an all-day event" },
  end: { type: "string" as const, pattern: TIME, description: "HH:MM; default start + 1 h" },
  endDate: { type: "string" as const, pattern: DATE, description: "last day, for multi-day events" },
  location: { type: "string" as const, maxLength: 300 },
  notes: { type: "string" as const, maxLength: 2000 },
};

export function familyTools(d: FamilyDeps): Tool[] {
  const tools: Tool[] = [
    {
      name: "calendar_list",
      description: "List events on the family, school and hobbies calendars between two dates (inclusive). Read-only.",
      input: {
        properties: {
          from: { type: "string", pattern: DATE, description: "YYYY-MM-DD, default today" },
          to: { type: "string", pattern: DATE, description: "YYYY-MM-DD, default from + 7 days" },
        },
      },
      async run(a) {
        const from = (a.from as string) ?? localParts(d.now()).date;
        const to = (a.to as string) ?? addDays(from, 7);
        const span = daysBetween(from, to);
        if (span < 0) throw new ToolError("to is before from");
        if (span > MAX_LIST_DAYS) throw new ToolError(`at most ${MAX_LIST_DAYS} days at a time`);
        const out = [];
        for (const which of ["family", "school", "hobbies"] as const) {
          const id = calId(d.cfg, which);
          if (!id) continue;
          const evs = await cal(d).list(id, { timeMin: localIso(from, "00:00"), timeMax: localIso(addDays(to, 1), "00:00") });
          for (const e of evs.filter((x) => x.status !== "cancelled")) {
            out.push({
              calendar: which,
              id: e.id,
              title: e.summary ?? "",
              start: when(e.start),
              end: when(e.end),
              location: e.location,
              addedByChat: e.extendedProperties?.private?.agent === CHAT_TAG,
            });
          }
        }
        return out.sort((x, y) => x.start.localeCompare(y.start));
      },
    },
    {
      name: "calendar_add",
      description:
        "Add an event to the school or hobbies calendar. Returns the existing event instead if one with the same title and start is already there.",
      input: { properties: { calendar: calendarProp, ...fields }, required: ["calendar", "title", "date"] },
      async run(a) {
        const which = a.calendar as Writable;
        const calendarId = writableId(d, which);
        const t = eventTimes(a.date as string, a.start as string, a.end as string, a.endDate as string);
        const same = await cal(d).list(calendarId, { timeMin: localIso(a.date as string, "00:00"), timeMax: localIso(addDays(a.date as string, 1), "00:00") });
        const dup = same.find((e) => e.status !== "cancelled" && e.summary === a.title && when(e.start) === when(t.start));
        if (dup) return { status: "already there", id: dup.id, calendar: which };
        const ev = await cal(d).insert(calendarId, {
          // Our own id (Google allows a-v and 0-9), so a retried call can't create a second copy.
          id: `chat${randomBytes(12).toString("hex")}`,
          summary: a.title as string,
          ...t,
          location: a.location as string | undefined,
          description: [a.notes, "Added from the family chat."].filter(Boolean).join("\n\n"),
          extendedProperties: { private: { agent: CHAT_TAG, createdAt: d.now().toISOString() } },
        } as CalendarEvent);
        return { status: "added", id: ev.id, calendar: which, start: when(t.start) };
      },
    },
    {
      name: "calendar_update",
      description: "Change an event this chat added (calendar_list shows addedByChat). Only the fields given change.",
      input: {
        properties: { calendar: calendarProp, id: { type: "string", maxLength: 1024 }, ...fields },
        required: ["calendar", "id"],
      },
      async run(a) {
        const which = a.calendar as Writable;
        const { calendarId, ev } = await ownEvent(d, which, a.id as string);
        const timesChanged = a.date || a.start || a.end || a.endDate;
        const next: CalendarEvent = {
          ...ev,
          summary: (a.title as string) ?? ev.summary,
          location: (a.location as string) ?? ev.location,
          description: a.notes ? `${a.notes}\n\nAdded from the family chat.` : ev.description,
          ...(timesChanged ? updatedTimes(ev, a as { date?: string; start?: string; end?: string; endDate?: string }) : {}),
        };
        await cal(d).update(calendarId, ev.id, next);
        return { status: "updated", id: ev.id, calendar: which, start: when(next.start) };
      },
    },
    {
      name: "calendar_delete",
      description:
        "Remove an event this chat added. Google keeps it as cancelled, it is not a permanent delete. Synced Wilma/MyClub events and human events cannot be removed.",
      input: { properties: { calendar: calendarProp, id: { type: "string", maxLength: 1024 } }, required: ["calendar", "id"] },
      async run(a) {
        const { calendarId, ev } = await ownEvent(d, a.calendar as Writable, a.id as string);
        await cal(d).delete(calendarId, ev.id);
        return { status: "removed", id: ev.id, title: ev.summary };
      },
    },
    {
      name: "week_overview",
      description: "Next 8 days as the Sunday week summary shows them (events, overlaps). Read-only, sends nothing.",
      input: { properties: {} },
      async run() {
        const c = ctx(d);
        const events = await collectHub(c, 8);
        const html = buildDigest({
          now: c.now,
          cfg: d.cfg,
          events,
          queue: [],
          changes: [],
          bills: [],
          health: {},
          weekAhead: true,
        });
        return stripHtml(html);
      },
    },
    {
      name: "digest_data",
      description:
        "Everything the morning digest (daily) or the Sunday week summary (week) needs, as data: events per day with who/what/place, overlaps where someone must drive two places, MyClub sign-ups closing and fees due, bills to remind today, school news (Wilma messages and notes waiting for the digest), changes since yesterday, sources that failed. Read-only: marks nothing as sent.",
      input: { properties: { kind: { type: "string", enum: ["daily", "week"] } }, required: ["kind"] },
      async run(a) {
        const c = ctx(d);
        const week = a.kind === "week";
        const today = localParts(c.now).date;
        const events = mergeCrossCalendar(await collectHub(c, week ? 8 : d.cfg.digest.coming_up_days));
        const days = week ? Array.from({ length: 7 }, (_, i) => addDays(today, i + 1)) : [today];
        const view = (e: (typeof events)[number]) => {
          const cancelled = /^CANCELLED: /.test(e.title);
          const { who, what } = splitTitle(e.title.replace(/^CANCELLED: /, ""));
          return { date: e.date, start: e.start, end: e.end, who, what, location: e.location, calendar: e.calendar, cancelled, tentative: e.tentative, alsoOnFamily: e.alsoOnFamily };
        };
        const myclub = c.state.myclub.lastSnapshot as MyClubSnapshot | undefined;
        const since = c.now.getTime() - 26 * 3600_000;
        return {
          today,
          kind: a.kind,
          days: days.map((day) => ({ date: day, events: events.filter((e) => e.date === day).map(view) })),
          comingUp: week ? [] : events.filter((e) => e.date > today).map(view),
          overlaps: days.flatMap((day) => conflicts(events.filter((e) => e.date === day)).map(([x, y]) => [view(x), view(y)])),
          signupsClosing: myclub ? openSignups(myclub, today, week ? 7 : 3).map((e) => ({ child: e.child, title: e.title, deadline: e.signup?.deadline })) : [],
          feesDue: myclub ? feesDue(myclub, today, 7) : [],
          billsToday: d.cfg.outlook.enabled && !d.group ? billsToRemind(c.state, today, d.cfg.outlook.remind_days_before).map((b) => ({ biller: b.biller, amount: b.amount, dueDate: b.dueDate, reference: b.reference, inDays: b.inDays })) : [],
          schoolNews: c.state.digestQueue,
          changedSinceYesterday: c.state.changes.filter((x) => Date.parse(x.at) > since && x.kind !== "new"),
          sourcesFailing: Object.entries(c.state.health).filter(([, h]) => !h.ok).map(([s]) => s),
        };
      },
    },
    {
      name: "week_plan",
      description:
        "Henri's Sunday week plan for next Monday to Sunday, ready to post to Henri as it is (Finnish, his layout): bills due (with the PDF's reference when the Email agent read it), MyClub fees and sign-ups, Wilma exams, driving clashes, each day, events per child and free evenings. Read-only, sends nothing. Henri's own chat only: it holds his bills.",
      input: { properties: {} },
      async run() {
        return weekPlan(ctx(d), d.deskFile, "markdown");
      },
    },
    {
      name: "bills_list",
      description: "Open bills found in Henri's Outlook: biller, amount, due date, reference, days left. Read-only; paying stays with Henri.",
      input: { properties: { all: { type: "boolean", description: "true = every tracked bill, default only due within 14 days or overdue" } } },
      async run(a) {
        const state = d.loadState();
        const today = localParts(d.now()).date;
        return state.outlook.bills
          .map((b) => ({
            biller: b.biller,
            amount: b.amount,
            dueDate: b.dueDate,
            reference: b.reference,
            subject: b.subject,
            inDays: b.dueDate ? daysBetween(today, b.dueDate) : undefined,
            newBiller: b.newBiller,
          }))
          .filter((b) => a.all || b.inDays === undefined || b.inDays <= 14)
          .sort((x, y) => (x.dueDate ?? "9999").localeCompare(y.dueDate ?? "9999"));
      },
    },
  ];
  return d.group ? tools.filter((t) => t.name !== "bills_list" && t.name !== "week_plan") : tools;
}

export function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}
