import type { Config } from "../config.js";
import type { CalendarEvent } from "../calendar/types.js";
import { startMs } from "../calendar/fake.js";
import type { Bill, ChangeRecord, StateData } from "../lib/state.js";
import { addDays, dayOf, localParts } from "../lib/time.js";
import { esc } from "../notify/telegram.js";
import type { MyClubSnapshot } from "../sources/myclub.js";
import { feesDue, openSignups } from "../sources/myclub.js";
import type { WilmaSnapshot } from "../sources/wilma.js";

// One combined message: calendar hub + flagged items from Wilma, MyClub and
// Outlook. Sections in plan order; empty sections are left out.

export interface HubEvent {
  calendar: "family" | "school" | "hobbies";
  title: string;
  date: string; // local YYYY-MM-DD
  start?: string; // HH:MM, absent for all-day
  end?: string;
  startMs: number;
  endMs: number;
  location?: string;
  tentative: boolean;
  alsoOnFamily?: boolean;
}

export interface DigestInput {
  now: Date;
  cfg: Config;
  events: HubEvent[];
  wilma?: WilmaSnapshot;
  myclub?: MyClubSnapshot;
  queue: StateData["digestQueue"];
  changes: ChangeRecord[];
  bills: (Bill & { inDays: number })[];
  health: StateData["health"];
  weekAhead?: boolean;
}

const L = {
  en: {
    title: "Family digest", week: "Week ahead", needs: "Needs action", today: "Today", conflicts: "Conflicts",
    changed: "Changed or cancelled since yesterday", coming: "Coming up", school: "School news", status: "Source status",
    allDay: "all day", bring: "bring", alsoFamily: "also on family calendar", homework: "homework", lessons: "lessons",
    due: "due", inDays: (n: number) => (n === 0 ? "today" : n < 0 ? `${-n} d overdue` : `in ${n} d`), signup: "sign-up closes",
    fee: "fee due", bill: "bill", newBiller: "new biller, check sender", reply: "needs reply/form/payment",
    unavailable: (s: string) => `${s} unavailable, this digest may be missing items`, nothing: "Nothing on the calendar.",
    cancelled: "cancelled", changedW: "changed", newW: "new",
  },
  fi: {
    title: "Perheen päivä", week: "Tuleva viikko", needs: "Vaatii toimia", today: "Tänään", conflicts: "Päällekkäisyydet",
    changed: "Muuttunut tai peruttu eilisen jälkeen", coming: "Tulossa", school: "Koulun tiedotteet", status: "Lähteiden tila",
    allDay: "koko päivä", bring: "mukaan", alsoFamily: "myös perhekalenterissa", homework: "läksyt", lessons: "tunnit",
    due: "eräpäivä", inDays: (n: number) => (n === 0 ? "tänään" : n < 0 ? `${-n} pv myöhässä` : `${n} pv päästä`), signup: "ilmoittautuminen sulkeutuu",
    fee: "maksu erääntyy", bill: "lasku", newBiller: "uusi laskuttaja, tarkista lähettäjä", reply: "vaatii vastauksen/lomakkeen/maksun",
    unavailable: (s: string) => `${s} ei vastannut, kooste voi olla vajaa`, nothing: "Ei kalenterimerkintöjä.",
    cancelled: "peruttu", changedW: "muuttunut", newW: "uusi",
  },
};

const BRING: [RegExp, string][] = [
  [/ui(nti|mahalli)|swim/i, "swimming gear"],
  [/jalkapallo|football|soccer|futis|salibandy|floorball|jääkiekko|hockey|koripallo|basket|harjoitus|harkat|treeni|training|practice|ottelu|match|game|turnaus|tournament/i, "sports kit"],
  [/exam|koe\b|kokeet/i, "exam prep"],
  [/retki|trip|excursion/i, "packed lunch, outdoor clothes"],
];

function bring(title: string): string | undefined {
  return BRING.find(([re]) => re.test(title))?.[1];
}

export function toHubEvent(e: CalendarEvent, calendar: HubEvent["calendar"]): HubEvent {
  const s = startMs(e.start);
  const en = startMs(e.end);
  const allDay = "date" in e.start;
  const lp = localParts(new Date(s));
  return {
    calendar,
    title: e.summary ?? "(untitled)",
    date: allDay ? (e.start as { date: string }).date : lp.date,
    start: allDay ? undefined : lp.time,
    end: allDay ? undefined : localParts(new Date(en)).time,
    startMs: s,
    endMs: en,
    location: e.location,
    tentative: e.status === "tentative",
  };
}

function words(t: string) {
  return new Set(t.toLowerCase().replace(/^[^:]{1,30}:\s*/, "").replace(/\(from bulletin\)/, "").split(/[^a-zåäö0-9]+/i).filter((w) => w.length > 2));
}

/** Same day + similar title on the family calendar and an agent calendar: show once. */
export function mergeCrossCalendar(events: HubEvent[]): HubEvent[] {
  const fam = events.filter((e) => e.calendar === "family");
  const out: HubEvent[] = [];
  const dropped = new Set<HubEvent>();
  for (const e of events.filter((x) => x.calendar !== "family")) {
    const a = words(e.title);
    const twin = fam.find((f) => {
      if (f.date !== e.date || dropped.has(f)) return false;
      const b = words(f.title);
      const common = [...a].filter((w) => b.has(w)).length;
      return common > 0 && common / Math.min(a.size, b.size) >= 0.5;
    });
    if (twin) {
      dropped.add(twin);
      out.push({ ...e, alsoOnFamily: true });
    } else out.push(e);
  }
  return [...out, ...fam.filter((f) => !dropped.has(f))].sort((x, y) => x.startMs - y.startMs);
}

function who(title: string): string | undefined {
  const m = title.match(/^(?:CANCELLED: )?([^:]{1,30}):/);
  return m?.[1];
}

/** Two timed events for different people overlapping: someone has to drive two places. */
export function conflicts(events: HubEvent[]): [HubEvent, HubEvent][] {
  const timed = events.filter((e) => e.start && !/^CANCELLED/.test(e.title));
  const out: [HubEvent, HubEvent][] = [];
  for (let i = 0; i < timed.length; i++)
    for (let j = i + 1; j < timed.length; j++) {
      const a = timed[i];
      const b = timed[j];
      if (a.startMs < b.endMs && b.startMs < a.endMs && who(a.title) !== who(b.title) && a.location !== b.location) out.push([a, b]);
    }
  return out;
}

function line(e: HubEvent, t: (typeof L)["en"]): string {
  const time = e.start ? `${e.start}${e.end ? `–${e.end}` : ""}` : t.allDay;
  const extras = [e.location, bring(e.title) ? `${t.bring}: ${bring(e.title)}` : "", e.alsoOnFamily ? t.alsoFamily : ""].filter(Boolean);
  return `• ${time} ${esc(e.title)}${extras.length ? ` <i>(${esc(extras.join(", "))})</i>` : ""}`;
}

export function buildDigest(inp: DigestInput): string {
  const t = L[inp.cfg.digest.language] ?? L.en;
  const today = localParts(inp.now).date;
  const events = mergeCrossCalendar(inp.events);
  const out: string[] = [];
  const section = (title: string, lines: string[]) => {
    if (lines.length) out.push(`<b>${esc(title)}</b>\n${lines.join("\n")}`);
  };

  out.push(`<b>${inp.weekAhead ? t.week : t.title} · ${today} (${dayOf(today)})</b>`);

  // 1. Needs action
  const needs: string[] = [];
  for (const q of inp.queue.filter((x) => x.action)) needs.push(`• ${esc(q.child)}: ${esc(q.text)} <i>(Wilma, ${t.reply})</i>`);
  if (inp.myclub) {
    for (const e of openSignups(inp.myclub, today, inp.weekAhead ? 7 : 3)) needs.push(`• ${esc(e.child ? `${e.child}: ` : "")}${esc(e.title)}: ${t.signup} ${e.signup!.deadline} <i>(MyClub)</i>`);
    for (const f of feesDue(inp.myclub, today, 7)) needs.push(`• ${esc(f.club)}: ${t.fee} ${f.dueDate}, ${esc(f.amount)}${f.reference ? `, ref ${esc(f.reference)}` : ""} <i>(MyClub)</i>`);
  }
  for (const b of inp.bills) needs.push(billLine(b, t));
  section(t.needs, needs);

  // 2. Today (or each day for the week-ahead)
  const days = inp.weekAhead ? Array.from({ length: 7 }, (_, i) => addDays(today, i + 1)) : [today];
  for (const day of days) {
    const lines = events.filter((e) => e.date === day).map((e) => line(e, t));
    if (inp.wilma && !inp.weekAhead) {
      for (const st of inp.wilma.students) {
        const lessons = st.lessons.filter((l) => l.date === day).sort((a, b) => a.start.localeCompare(b.start));
        if (lessons.length) lines.push(`• ${esc(st.name)}: ${t.lessons} ${lessons[0].start}–${lessons[lessons.length - 1].end}`);
        const hw = st.homework.filter((h) => h.date === day || h.date === addDays(day, 1));
        for (const h of hw) lines.push(`• ${esc(st.name)}: ${t.homework} ${esc(h.subject)}: ${esc(h.text.slice(0, 120))}`);
      }
    }
    if (inp.weekAhead) section(`${day} (${dayOf(day)})`, lines);
    else section(t.today, lines.length ? lines : [t.nothing]);
  }
  if (inp.weekAhead && !events.some((e) => days.includes(e.date))) out.push(t.nothing);

  // 3. Conflicts
  const conf = days.flatMap((d) => conflicts(events.filter((e) => e.date === d)));
  section(t.conflicts, conf.map(([a, b]) => `• ${a.date} ${a.start} ${esc(a.title)} ↔ ${b.start} ${esc(b.title)}`));

  // 4. Changed or cancelled since yesterday
  const since = inp.now.getTime() - 26 * 3600000;
  const ch = inp.changes.filter((c) => Date.parse(c.at) > since && c.kind !== "new");
  section(t.changed, ch.map((c) => `• ${c.kind === "cancelled" ? t.cancelled : t.changedW}: ${esc(c.title)} (${c.when})`));

  // 5. Coming up: exams and tournaments in the next N days
  if (!inp.weekAhead) {
    const horizon = addDays(today, inp.cfg.digest.coming_up_days);
    const coming = events.filter((e) => e.date > today && e.date <= horizon && /exam|koe\b|turnaus|tournament|cup|ottelu|match/i.test(e.title));
    section(t.coming, coming.map((e) => `• ${e.date} ${esc(e.title)}${e.alsoOnFamily ? ` <i>(${t.alsoFamily})</i>` : ""}`));
  }

  // School news that needs no action
  section(t.school, inp.queue.filter((x) => !x.action).map((q) => `• ${esc(q.child)}: ${esc(q.text)}`));

  // Source health: never let a failed read look like an empty day.
  const bad = Object.entries(inp.health).filter(([, h]) => !h.ok);
  section(t.status, bad.map(([s]) => `⚠️ ${t.unavailable(s)}`));
  const warn = inp.myclub?.warnings ?? [];
  if (warn.length && !bad.length) section(t.status, warn.slice(0, 2).map((w) => `ℹ️ ${esc(w)}`));

  return out.join("\n\n");
}

export function billLine(b: Bill & { inDays: number }, t: (typeof L)["en"] = L.en): string {
  return `• ${t.bill}: ${esc(b.biller)}${b.amount ? `, ${esc(b.amount)}` : ""}, ${t.due} ${b.dueDate} (${t.inDays(b.inDays)})${b.reference ? `, ref ${esc(b.reference)}` : ""}${b.newBiller ? ` ⚠️ <i>${t.newBiller}: ${esc(b.sender)}</i>` : ""}`;
}

export function billsMessage(bills: (Bill & { inDays: number })[], cfg: Config): string {
  const t = L[cfg.digest.language] ?? L.en;
  return `<b>${t.needs}: ${t.bill}</b>\n${bills.map((b) => billLine(b, t)).join("\n")}`;
}
