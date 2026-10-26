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
    days: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"], short: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
    overlap: (from: string, to: string) => `${from}–${to} overlap`, and: "and", who: "who drives?",
    bringWhat: { swim: "swimming gear", exam: "exam prep", trip: "packed lunch, outdoor clothes" } as Record<string, string>,
  },
  fi: {
    title: "Perheen päivä", week: "Tuleva viikko", needs: "Vaatii toimia", today: "Tänään", conflicts: "Päällekkäisyydet",
    changed: "Muuttunut tai peruttu eilisen jälkeen", coming: "Tulossa", school: "Koulun tiedotteet", status: "Lähteiden tila",
    allDay: "koko päivä", bring: "mukaan", alsoFamily: "myös perhekalenterissa", homework: "läksyt", lessons: "tunnit",
    due: "eräpäivä", inDays: (n: number) => (n === 0 ? "tänään" : n < 0 ? `${-n} pv myöhässä` : `${n} pv päästä`), signup: "ilmoittautuminen sulkeutuu",
    fee: "maksu erääntyy", bill: "lasku", newBiller: "uusi laskuttaja, tarkista lähettäjä", reply: "vaatii vastauksen/lomakkeen/maksun",
    unavailable: (s: string) => `${s} ei vastannut, kooste voi olla vajaa`, nothing: "Ei kalenterimerkintöjä.",
    cancelled: "peruttu", changedW: "muuttunut", newW: "uusi",
    days: ["Sunnuntai", "Maanantai", "Tiistai", "Keskiviikko", "Torstai", "Perjantai", "Lauantai"], short: ["su", "ma", "ti", "ke", "to", "pe", "la"],
    overlap: (from: string, to: string) => `Päällekkäin ${from}–${to}`, and: "ja", who: "kuka vie?",
    bringWhat: { swim: "uimakamat", exam: "kokeeseen valmistautuminen", trip: "eväät ja ulkovaatteet" } as Record<string, string>,
  },
};

// Only reminders that aren't obvious: every practice needs its kit.
const BRING: [RegExp, string][] = [
  [/ui(nti|mahalli)|swim/i, "swim"],
  [/exam|koe\b|kokeet/i, "exam"],
  [/retki|trip|excursion/i, "trip"],
];

function bring(title: string, t: Labels): string | undefined {
  const k = BRING.find(([re]) => re.test(title))?.[1];
  return k && t.bringWhat[k];
}


export type Labels = (typeof L)["en"];

/** "torstai 22.10." style dates. */
export function niceDate(date: string, t: Labels, long = false): string {
  const [, m, d] = date.split("-").map(Number);
  const wd = new Date(`${date}T12:00:00Z`).getUTCDay();
  return `${long ? t.days[wd] : t.short[wd]} ${d}.${m}.`;
}

/**
 * "Oskar: Taitokoulut: Taitokoulu 2017 -syntyneet Hallikausi 2026-2027" ->
 * who "Oskar", what "Taitokoulu 2017 -syntyneet". Short event names keep
 * their team: "K-E Blues 15: Jäävuoro".
 */
export function splitTitle(title: string): { who?: string; what: string } {
  const parts = title.split(/:\s+/);
  const who = parts.length > 1 && parts[0].length <= 30 && !/\s/.test(parts[0].trim()) ? parts.shift()!.trim() : undefined;
  const clean = (x: string) => x.replace(/\s*\b(hallikausi|kausi|season)\s*\d{4}(\s*[-–\/]\s*\d{2,4})?/gi, "").replace(/\s{2,}/g, " ").trim();
  let what = clean(parts[parts.length - 1] ?? title);
  if (parts.length > 1 && what.length < 20) what = `${clean(parts[parts.length - 2])}: ${what}`;
  return { who, what: what || title };
}

/** First part of the address, linked to a map search of the full one. */
function place(location: string): string {
  const short = location.split(",")[0].trim();
  return `<a href="https://maps.google.com/?q=${encodeURIComponent(location)}">${esc(short)}</a>`;
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

/**
 * Finnish output never shows the English markers the syncs put in calendar
 * titles: "(from bulletin)" becomes "(tiedote)", or goes when the title already
 * says tiedote; "(not going)" becomes "(ei mene)". "CANCELLED: " stays, it is
 * rendered as "peruttu" where events are shown.
 */
export function fiTitle(title: string): string {
  return title
    .replace(/\s*\(from bulletin\)/i, (_m, off: number, all: string) => (/tiedote/i.test(all.slice(0, off)) ? "" : " (tiedote)"))
    .replace(/\s*\(not going\)$/i, " (ei mene)");
}

export function localTitles(events: HubEvent[], lang: string): HubEvent[] {
  return lang === "fi" ? events.map((e) => ({ ...e, title: fiTitle(e.title) })) : events;
}

function who(title: string): string | undefined {
  const m = title.match(/^(?:CANCELLED: )?([^:]{1,30}):/);
  return m?.[1];
}

/** Games, tournaments and exams: the only events "Coming up" lists (not practices, ice times or newsletters). */
export function isComingUp(title: string): boolean {
  // Named games first, so "Harjoitusottelu" (a practice match) stays in.
  if (/exam|koe\b|turnaus|tournament|cup|ottelu|match|peli\b|game\b|\bvs\b/i.test(title)) return true;
  if (/harjoit|treeni|jäävuoro|omatoimi|taitokoulu|tiedote|practice/i.test(title)) return false;
  // "K-Espoo Blues 3 - Ice Force": two teams around a spaced dash is a game, and so is a
  // team colour: "Futsal - Sininen" is a game (Henri, 2026-10-26). A "Ryhmä ..." group is a practice.
  const m = title.match(/\s[-–]\s(.*)$/);
  return !!m && !GROUP_RE.test(m[1].trim());
}
const GROUP_RE = /^(ryhmä|group)(?=\s|$)/i;

/**
 * "Changed or cancelled since yesterday", as the family reads it: only events from
 * today to the Coming up horizon, never the tentative bulletin dates (Wilma text
 * re-reads churn them), one line per event (the last change wins, so a renamed
 * event isn't listed under both titles), Finnish dates (Henri, 2026-10-26).
 */
export function digestChanges(changes: ChangeRecord[], now: Date, cfg: Config): ChangeRecord[] {
  const since = now.getTime() - 26 * 3600000;
  const today = localParts(now).date;
  const horizon = addDays(today, cfg.digest.coming_up_days);
  const byEvent = new Map<string, ChangeRecord>();
  for (const c of changes) {
    const date = c.when.slice(0, 10);
    if (Date.parse(c.at) <= since || c.kind === "new" || /\(from bulletin\)/i.test(c.title) || date < today || date > horizon) continue;
    const key = `${c.source}|${c.when}|${who(c.title.replace(/^CANCELLED: /, "")) ?? c.title}`;
    byEvent.delete(key); // keep the latest, in order
    byEvent.set(key, c);
  }
  return [...byEvent.values()];
}

/** "2026-10-25 13:30" -> "su 25.10. klo 13.30" (Finnish) or "Sun 25.10. 13:30". */
export function whenLabel(when: string, t: Labels): string {
  const [date, time] = when.split(" ");
  if (!/^\d{4}-\d\d-\d\d$/.test(date)) return when;
  return `${niceDate(date, t)}${time ? ` ${t === L.fi ? `klo ${time.replace(":", ".")}` : time}` : ""}`;
}

/** Two timed events in different places overlapping: someone has to drive two places,
 * or one child is booked in two places at once. */
export function conflicts(events: HubEvent[]): [HubEvent, HubEvent][] {
  const timed = events.filter((e) => e.start && !/^CANCELLED/.test(e.title) && !/\((not going|ei mene)\)$/.test(e.title));
  const out: [HubEvent, HubEvent][] = [];
  for (let i = 0; i < timed.length; i++)
    for (let j = i + 1; j < timed.length; j++) {
      const a = timed[i];
      const b = timed[j];
      if (a.startMs < b.endMs && b.startMs < a.endMs && a.location !== b.location) out.push([a, b]);
    }
  return out;
}

function line(e: HubEvent, t: Labels): string {
  const time = e.start ? `${e.start}${e.end ? `–${e.end}` : ""}` : t.allDay;
  const cancelled = /^CANCELLED: /.test(e.title);
  const { who, what } = splitTitle(e.title.replace(/^CANCELLED: /, ""));
  const head = `• <b>${time}</b> ${who ? `<b>${esc(who)}</b> · ` : ""}${esc(what)}`;
  const b = bring(e.title, t);
  const extras = [e.location ? `📍 ${place(e.location)}` : "", b ? `🎒 ${esc(b)}` : "", e.alsoOnFamily ? `<i>${t.alsoFamily}</i>` : ""].filter(Boolean);
  return `${cancelled ? `<s>${head}</s> <i>${t.cancelled}</i>` : head}${extras.length ? `\n ${extras.join("  ")}` : ""}`;
}

function conflictLine([a, b]: [HubEvent, HubEvent], t: Labels, withDay = false): string {
  const hm = (ms: number) => localParts(new Date(ms)).time;
  const from = hm(Math.max(a.startMs, b.startMs));
  const to = hm(Math.min(a.endMs, b.endMs));
  // One child in two places names the two events; two children name who.
  const same = !!who(a.title) && who(a.title) === who(b.title);
  const side = (e: HubEvent) => {
    const { who, what } = splitTitle(e.title);
    return `${esc(same ? what : (who ?? what))}${e.location ? ` (${esc(e.location.split(",")[0].trim())})` : ""}`;
  };
  const day = withDay ? `${niceDate(localParts(new Date(Math.max(a.startMs, b.startMs))).date, t)} ` : "";
  return `• ${day}${t.overlap(from, to)}: ${same ? `${esc(who(a.title)!)}: ` : ""}${side(a)} ${t.and} ${side(b)}, ${t.who}`;
}

/** The digest labels for the configured language. */
export function labels(cfg: Config): Labels {
  return L[cfg.digest.language as keyof typeof L] ?? L.en;
}

export function buildDigest(inp: DigestInput): string {
  const t = L[inp.cfg.digest.language] ?? L.en;
  const today = localParts(inp.now).date;
  const events = localTitles(mergeCrossCalendar(inp.events), inp.cfg.digest.language);
  const out: string[] = [];
  const icons: Record<string, string> = { [t.needs]: "✅", [t.today]: "📅", [t.conflicts]: "🚗", [t.changed]: "🔄", [t.coming]: "🔜", [t.school]: "🏫", [t.status]: "🔧" };
  const section = (title: string, lines: string[], sep = "\n") => {
    if (lines.length) out.push(`${icons[title] ?? "▫️"} <b>${esc(title)}</b>\n${lines.join(sep)}`);
  };

  out.push(inp.weekAhead ? `🗓 <b>${t.week}</b>` : `☀️ <b>${t.title}</b> · ${niceDate(today, t, true)}`);

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
    // Events take two lines (time, then place): an empty line keeps them apart.
    if (inp.weekAhead) section(niceDate(day, t, true), lines, "\n\n");
    else section(t.today, lines.length ? lines : [t.nothing], "\n\n");
  }
  if (inp.weekAhead && !events.some((e) => days.includes(e.date))) out.push(t.nothing);

  // 3. Conflicts: today's, and in the daily digest also those in the coming days
  const conf = days.flatMap((d) => conflicts(events.filter((e) => e.date === d)));
  const confLines = conf.map((c) => conflictLine(c, t, !!inp.weekAhead));
  if (!inp.weekAhead) {
    for (let i = 1; i <= inp.cfg.digest.coming_up_days; i++) {
      const d = addDays(today, i);
      for (const c of conflicts(events.filter((e) => e.date === d))) confLines.push(conflictLine(c, t, true));
    }
  }
  section(t.conflicts, confLines);

  // 4. Changed or cancelled since yesterday
  const ch = digestChanges(inp.changes, inp.now, inp.cfg);
  const fi = inp.cfg.digest.language === "fi";
  section(t.changed, ch.map((c) => `• ${c.kind === "cancelled" ? t.cancelled : t.changedW}: ${esc((fi ? fiTitle(c.title) : c.title).replace(/^CANCELLED: /, ""))} (${whenLabel(c.when, t)})`));

  // 5. Coming up: games, tournaments and exams in the next N days
  if (!inp.weekAhead) {
    const horizon = addDays(today, inp.cfg.digest.coming_up_days);
    const coming = events.filter((e) => e.date > today && e.date <= horizon && isComingUp(e.title));
    section(t.coming, coming.map((e) => {
      const { who, what } = splitTitle(e.title);
      return `• <b>${niceDate(e.date, t)}</b>${e.start ? ` ${e.start}` : ""} ${who ? `<b>${esc(who)}</b> · ` : ""}${esc(what)}${e.alsoOnFamily ? ` <i>(${t.alsoFamily})</i>` : ""}${e.location ? `\n 📍 ${place(e.location)}` : ""}`;
    }), "\n\n");
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

export function billLine(b: Bill & { inDays: number }, t: Labels = L.en): string {
  const due = b.dueDate ? `${t.due} ${niceDate(b.dueDate, t)} (${t.inDays(b.inDays)})` : "";
  return `• <b>${esc(b.biller)}</b>${b.amount ? ` ${esc(b.amount)}` : ""}${due ? ` · ${due}` : ""}${b.reference ? ` · ref ${esc(b.reference)}` : ""}${b.newBiller ? `\n ⚠️ <i>${t.newBiller}: ${esc(b.sender)}</i>` : ""}`;
}

export function billsMessage(bills: (Bill & { inDays: number })[], cfg: Config): string {
  const t = L[cfg.digest.language] ?? L.en;
  return `<b>${t.needs}: ${t.bill}</b>\n${bills.map((b) => billLine(b, t)).join("\n")}`;
}
