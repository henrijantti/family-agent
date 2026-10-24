import { deskBills, type DeskItem } from "../agent/desk.js";
import { collectHub, type Ctx } from "../jobs.js";
import type { Bill, StateData } from "../lib/state.js";
import { addDays, daysBetween, localParts } from "../lib/time.js";
import { esc } from "../notify/telegram.js";
import { feesDue, openSignups, type MyClubSnapshot } from "../sources/myclub.js";
import type { WilmaSnapshot } from "../sources/wilma.js";
import { conflicts, mergeCrossCalendar, splitTitle, type HubEvent } from "./build.js";

// Henri's Sunday week planner: one private message from the Chief of staff
// with what the coming week needs from him. Unlike the family group's week
// summary it carries his bills, and it opens with the to-dos, then exams,
// driving clashes and the days, and ends with a short count per child.
//
// Rendered here, not by the model, so the layout is always Henri's: plain
// bullets, the place on its own line, one empty line between items and
// between sections. Two outputs: Telegram HTML (sent by code) and Markdown
// (an OpenClaw agent posts it as is; OpenClaw turns it into Telegram format).

export interface PlanBill {
  messageId?: string;
  /** A name from the bill scan, or the sender's domain for mail desk results. */
  biller: string;
  amount?: string;
  currency?: string;
  due?: string;
  reference?: string;
  newBiller?: boolean;
  ibanChanged?: boolean;
}

export interface WeekPlanInput {
  now: Date;
  events: HubEvent[];
  children: string[];
  bills: PlanBill[];
  myclub?: MyClubSnapshot;
  wilma?: WilmaSnapshot;
  queue: StateData["digestQueue"];
  health: StateData["health"];
  format: "html" | "markdown";
}

const DAYS = ["Sunnuntai", "Maanantai", "Tiistai", "Keskiviikko", "Torstai", "Perjantai", "Lauantai"];
const SHORT = ["su", "ma", "ti", "ke", "to", "pe", "la"];
const EVENING = "16:00";

const wd = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();
const dm = (date: string) => {
  const [, m, d] = date.split("-").map(Number);
  return `${d}.${m}.`;
};
const short = (date: string) => `${SHORT[wd(date)]} ${dm(date)}`;

/** ISO week number of a YYYY-MM-DD date. */
export function isoWeek(date: string): number {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 3 - ((d.getUTCDay() + 6) % 7)); // the Thursday of that week
  const jan4 = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  return 1 + Math.round((d.getTime() - jan4.getTime()) / 86400000 / 7 - 3 / 7 + ((jan4.getUTCDay() + 6) % 7) / 7);
}

/** "84.20" or "1 084,20 €" -> 1084.2; undefined when it isn't a plain amount. */
export function parseAmount(s?: string): number | undefined {
  if (!s) return undefined;
  const t = s.replace(/[\s €]|eur(oa)?/gi, "");
  const n = /,\d{2}$/.test(t) ? t.replace(/\./g, "").replace(",", ".") : t.replace(/,/g, "");
  return /^\d+(\.\d{1,2})?$/.test(n) ? Number(n) : undefined;
}

export const euros = (n: number) => `${n.toFixed(2).replace(".", ",").replace(/\B(?=(\d{3})+(?!\d))/g, " ")} €`;

function amountText(b: PlanBill): string | undefined {
  const n = parseAmount(b.amount);
  if (n === undefined) return b.amount;
  return b.currency && b.currency !== "EUR" ? `${n.toFixed(2).replace(".", ",")} ${b.currency}` : euros(n);
}

function dueText(due: string, today: string): string {
  const n = daysBetween(today, due);
  const rel = n < 0 ? `${-n} pv myöhässä` : n === 0 ? "tänään" : n === 1 ? "huomenna" : `${n} pv päästä`;
  return `eräpäivä ${short(due)} (${rel})`;
}

/** Bills worth a line this week: due by the week's end (overdue up to a week), or found this week without a due date. */
export function billsForWeek(bills: PlanBill[], today: string): PlanBill[] {
  const end = addDays(today, 7);
  return bills
    .filter((b) => (b.due ? b.due <= end && b.due >= addDays(today, -7) : true))
    .sort((x, y) => (x.due ?? "9999").localeCompare(y.due ?? "9999"));
}

export function buildWeekPlan(inp: WeekPlanInput): string {
  const md = inp.format === "markdown";
  // Markdown: drop the characters that would turn a title into formatting.
  const t = (s: string) => (md ? s.replace(/[*_`~[\]]/g, "") : esc(s));
  const b = (s: string) => (md ? `**${t(s)}**` : `<b>${t(s)}</b>`);
  const strike = (s: string) => (md ? `~~${s}~~` : `<s>${s}</s>`);

  const today = localParts(inp.now).date;
  const days = Array.from({ length: 7 }, (_, i) => addDays(today, i + 1));
  const first = days[0];
  const last = days[6];
  const inWeek = (d?: string) => !!d && d >= first && d <= last;
  const events = mergeCrossCalendar(inp.events).filter((e) => inWeek(e.date));
  const out: string[] = [];
  const section = (title: string, items: string[]) => {
    if (items.length) out.push(`${title}\n\n${items.join("\n\n")}`);
  };

  out.push(`🗓 ${b(`Viikkosuunnitelma, vk ${isoWeek(first)}`)}\n${short(first)} – ${short(last)}`);

  // 1. What Henri must do
  const todo: string[] = [];
  for (const bill of billsForWeek(inp.bills, today)) {
    const amount = amountText(bill);
    const details = [bill.due ? dueText(bill.due, today) : "eräpäivä puuttuu", bill.reference ? `viite ${t(bill.reference)}` : ""].filter(Boolean).join(" · ");
    const warn = [bill.ibanChanged ? "⚠️ tilinumero vaihtunut, tarkista ennen maksua" : "", bill.newBiller ? "⚠️ uusi laskuttaja, tarkista lähettäjä" : ""].filter(Boolean);
    todo.push([`• ${b(bill.biller)}${amount ? ` ${t(amount)}` : ""}`, ` ${details}`, ...warn.map((w) => ` ${w}`)].join("\n"));
  }
  if (inp.myclub) {
    for (const f of feesDue(inp.myclub, today, 7)) todo.push(`• ${b(`${f.club}: kausimaksu`)} ${t(f.amount)}\n ${dueText(f.dueDate, today)}${f.reference ? ` · viite ${t(f.reference)}` : ""}`);
    for (const e of openSignups(inp.myclub, today, 7)) {
      const { who, what } = splitTitle(e.title);
      const name = e.child ?? who;
      todo.push(`• ${b(`${name ? `${name}: ` : ""}ilmoittautuminen`)}\n ${t(what)}\n sulkeutuu ${short(e.signup!.deadline!)}`);
    }
  }
  for (const q of inp.queue.filter((x) => x.action)) todo.push(`• ${b(`${q.child}: Wilma`)}\n ${t(q.text.slice(0, 160))}`);
  section(`✅ ${b("Hoida tällä viikolla")}`, todo);

  // 2. Exams (Wilma), with the topic to prepare for
  const exams = (inp.wilma?.students ?? []).flatMap((st) => st.exams.filter((x) => inWeek(x.date)).map((x) => ({ child: st.name, ...x })));
  exams.sort((x, y) => x.date.localeCompare(y.date));
  section(
    `📝 ${b("Kokeet")}`,
    exams.map((x) => `• ${b(short(x.date))} ${b(x.child)} · ${t(x.subject || x.name)}${x.topic ? `\n ${t(x.topic.slice(0, 120))}` : ""}`),
  );

  // 3. Driving clashes
  const hm = (ms: number) => localParts(new Date(ms)).time;
  const side = (e: HubEvent) => {
    const { who, what } = splitTitle(e.title);
    return `${t(who ?? what)}${e.location ? ` (${t(e.location.split(",")[0].trim())})` : ""}`;
  };
  section(
    `🚗 ${b("Kuljetukset")}`,
    days.flatMap((d) =>
      conflicts(events.filter((e) => e.date === d)).map(
        ([x, y]) => `• ${b(short(d))} ${hm(Math.max(x.startMs, y.startMs))}–${hm(Math.min(x.endMs, y.endMs))}\n ${side(x)} ja ${side(y)}\n kuka vie?`,
      ),
    ),
  );

  // 4. The days; empty days are named once in the summary instead
  for (const d of days) {
    const lines = events
      .filter((e) => e.date === d)
      .map((e) => {
        const cancelled = /^CANCELLED: /.test(e.title);
        const { who, what } = splitTitle(e.title.replace(/^CANCELLED: /, ""));
        const head = `${b(e.start ? `${e.start}${e.end ? `–${e.end}` : ""}` : "koko päivä")} ${who ? `${b(who)} · ` : ""}${t(what)}`;
        const place = e.location ? `\n 📍 ${t(e.location.split(",")[0].trim())}` : "";
        return `• ${cancelled ? `${strike(head)} peruttu` : head}${place}`;
      });
    section(`📅 ${b(`${DAYS[wd(d)]} ${dm(d)}`)}`, lines);
  }
  if (!events.length) out.push("Ei kalenterimerkintöjä tälle viikolle.");

  // 5. The week in numbers
  const live = events.filter((e) => !/^CANCELLED: /.test(e.title));
  const summary: string[] = [];
  for (const child of inp.children) {
    const n = live.filter((e) => splitTitle(e.title).who?.toLowerCase() === child.toLowerCase()).length;
    summary.push(`• ${b(child)}: ${n === 0 ? "ei menoja" : n === 1 ? "1 meno" : `${n} menoa`}`);
  }
  // An evening is taken by a timed event running past 16:00, or an all-day one outside school (a tournament, a trip).
  const busy = new Set(live.filter((e) => (e.start ? (e.end ?? e.start) > EVENING : e.calendar !== "school")).map((e) => e.date));
  const free = days.filter((d) => !busy.has(d));
  summary.push(`• Vapaat illat: ${free.length ? free.map((d) => SHORT[wd(d)]).join(", ") : "ei yhtään"}`);
  const due = billsForWeek(inp.bills, today);
  const sums = due.map((x) => (x.currency && x.currency !== "EUR" ? undefined : parseAmount(x.amount)));
  if (due.length) {
    const total = sums.every((x) => x !== undefined) ? `, yhteensä ${euros(sums.reduce((a, x) => a! + x!, 0)!)}` : "";
    summary.push(`• Laskuja ${due.length}${total}`);
  }
  // Short one-liners: kept together, unlike the multi-line items above.
  if (summary.length) out.push(`📊 ${b("Viikko lyhyesti")}\n\n${summary.join("\n")}`);

  // Never let a failed read look like a quiet week.
  const bad = Object.entries(inp.health).filter(([, h]) => !h.ok);
  section(`🔧 ${b("Lähteiden tila")}`, bad.map(([s]) => `• ⚠️ ${t(s)} ei vastannut, suunnitelma voi olla vajaa`));

  return out.join("\n\n");
}

/**
 * One list from the bill scan (state) and the Email agent's bill reports (mail
 * desk). Same email: the desk fills in what the scan missed (the PDF's amount,
 * due date and reference). Desk-only bills are named by the sender's domain,
 * never by anything the email says.
 */
export function mergeBills(scanned: Bill[], desk: DeskItem[]): PlanBill[] {
  const out = new Map<string, PlanBill>();
  for (const x of scanned) out.set(x.messageId, { messageId: x.messageId, biller: x.biller, amount: x.amount, due: x.dueDate, reference: x.reference, newBiller: x.newBiller });
  for (const it of desk) {
    const prev = out.get(it.messageId!);
    const domain = it.sender?.split("@")[1] ?? "tuntematon laskuttaja";
    out.set(it.messageId!, {
      messageId: it.messageId,
      biller: prev?.biller ?? domain,
      amount: it.amount ?? prev?.amount,
      currency: it.amount ? it.currency : undefined,
      due: it.due ?? prev?.due,
      reference: it.reference ?? prev?.reference,
      newBiller: prev?.newBiller,
      ibanChanged: it.ibanChanged,
    });
  }
  return [...out.values()];
}

/** The week plan from live state and calendars. deskFile: the mail desk's file, for bills the Email agent read. */
export async function weekPlan(c: Ctx, deskFile: string | undefined, format: WeekPlanInput["format"]): Promise<string> {
  const events = await collectHub(c, 8);
  return buildWeekPlan({
    now: c.now,
    events,
    children: c.cfg.children.map((x) => x.name),
    bills: c.cfg.outlook.enabled ? mergeBills(c.state.outlook.bills, deskFile ? deskBills(deskFile, c.now) : []) : [],
    myclub: c.state.myclub.lastSnapshot as MyClubSnapshot | undefined,
    wilma: c.state.wilma.lastSnapshot as WilmaSnapshot | undefined,
    queue: c.state.digestQueue,
    health: c.state.health,
    format,
  });
}
