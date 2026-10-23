import { runAttendanceApply, runAttendancePoll, type AttendanceWriter } from "./attendance.js";
import { Config, RunSlot, env } from "./config.js";
import type { CalendarApi } from "./calendar/types.js";
import { syncSource } from "./calendar/sync.js";
import { HubEvent, billsMessage, buildDigest, toHubEvent } from "./digest/build.js";
import type { StateData } from "./lib/state.js";
import { addDays, fromLocal, inRange, localParts, toMinutes } from "./lib/time.js";
import { Notifier, esc } from "./notify/telegram.js";
import { MyClubProvider, MyClubSnapshot, myclubEvents } from "./sources/myclub.js";
import { MailApi, billsToRemind, ensureWilmaRule, scanInvoices } from "./sources/outlook.js";
import { type AssistantMail, type ReplyWriter, handleUpdates, offerReplies, type AssistantCtx } from "./mail-assistant.js";
import { WilmaProvider, WilmaSnapshot, wilmaDiff, wilmaEvents } from "./sources/wilma.js";

export interface Ctx {
  cfg: Config;
  state: StateData;
  now: Date;
  calendar?: CalendarApi; // undefined until the Google service account is set up
  wilma?: WilmaProvider;
  myclub?: MyClubProvider;
  /** Events each child is invited to but hasn't answered: the weekly poll's source. */
  myclubInvites?: MyClubProvider;
  mail?: MailApi & Partial<AssistantMail>;
  notifier?: Notifier;
  /** Writes email reply drafts; undefined = Henri types them (writer: manual). */
  replyWriter?: ReplyWriter;
  /** MyClub sign-up writer; a dry run until verified (attendance.live). */
  attendanceWriter?: AttendanceWriter;
  log: (s: string) => void;
}

const familyChat = () => env("TELEGRAM_FAMILY_CHAT_ID");
const privateChat = () => env("TELEGRAM_PRIVATE_CHAT_ID");

export function calId(cfg: Config, which: "family" | "school" | "hobbies") {
  const name = which === "family" ? cfg.calendar.family_calendar_id_env : which === "school" ? cfg.calendar.school_calendar_id_env : cfg.calendar.hobbies_calendar_id_env;
  return env(name);
}

function ok(ctx: Ctx, source: string, count?: number) {
  ctx.state.health[source] = { ok: true, at: ctx.now.toISOString(), lastCount: count ?? ctx.state.health[source]?.lastCount };
}

function fail(ctx: Ctx, source: string, err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  ctx.state.health[source] = { ...ctx.state.health[source], ok: false, at: ctx.now.toISOString(), error: msg };
  ctx.log(`${source} failed: ${msg}`);
}

async function sendAlert(ctx: Ctx, lines: string[]) {
  if (!lines.length || !ctx.notifier || !familyChat()) return;
  const lp = localParts(ctx.now);
  const q = ctx.cfg.alerts.quiet_hours;
  if (inRange(lp.minutes, q.from, q.to)) {
    ctx.log(`quiet hours: holding ${lines.length} alert(s) for the next digest`);
    return;
  }
  await ctx.notifier.send(familyChat()!, `🔔 <b>Family agent</b>\n${lines.map((l) => `• ${esc(l)}`).join("\n")}`);
}

async function syncInto(ctx: Ctx, which: "school" | "hobbies", source: "wilma" | "myclub", desired: ReturnType<typeof wilmaEvents>, days: number) {
  const id = calId(ctx.cfg, which);
  if (!ctx.calendar || !id) {
    ctx.log(`calendar not configured, skipping ${which} sync (${desired.length} items)`);
    return [];
  }
  const today = localParts(ctx.now).date;
  const r = await syncSource(ctx.calendar, desired, {
    calendarId: id,
    source,
    windowStart: fromLocal(today).toISOString(),
    windowEnd: fromLocal(addDays(today, days)).toISOString(),
    missingRunsBeforeDelete: ctx.cfg.calendar.missing_runs_before_delete,
    maxDeletes: ctx.cfg.calendar.max_deletes_per_run,
    now: ctx.now,
  });
  ctx.state.changes.push(...r.changes);
  ctx.log(`${which}: +${r.created} ~${r.updated} =${r.unchanged} -${r.deleted} (missing ${r.markedMissing})`);
  return r.warnings;
}

export async function runWilma(ctx: Ctx, slot?: RunSlot) {
  if (!ctx.wilma) return;
  const today = localParts(ctx.now).date;
  let snap: WilmaSnapshot;
  try {
    snap = await ctx.wilma.fetch(ctx.cfg, ctx.state);
    if (!snap.students.length) throw new Error("no children found on the Wilma login");
    ok(ctx, "Wilma", snap.students.length);
  } catch (e) {
    fail(ctx, "Wilma", e);
    return;
  }
  const warnings = await syncInto(ctx, "school", "wilma", wilmaEvents(snap, ctx.cfg, today), 120);
  const diff = wilmaDiff(snap, ctx.state, ctx.cfg, today);
  ctx.state.digestQueue.push(...diff.fresh);
  // Compact copy for the digest: no message bodies, no grades.
  ctx.state.wilma.lastSnapshot = {
    ...snap,
    students: snap.students.map((s) => ({ ...s, messages: [], news: [], notes: [] })),
  } satisfies WilmaSnapshot;
  if (slot?.alerts) {
    const urgent = [
      ...diff.fresh.filter((f) => f.action).map((f) => `${f.child}: ${f.text} (Wilma, needs action)`),
      ...diff.fresh.filter((f) => f.kind === "note").map((f) => `${f.child}: new lesson note: ${f.text}`),
      ...diff.examAlerts,
    ];
    await sendAlert(ctx, [...urgent, ...warnings]);
  } else if (warnings.length) await sendAlert(ctx, warnings);
}

export async function runMyClub(ctx: Ctx) {
  if (!ctx.myclub) return;
  let snap: MyClubSnapshot;
  try {
    snap = await ctx.myclub.fetch(ctx.cfg);
    const prev = ctx.state.health.MyClub?.lastCount ?? 0;
    if (snap.events.length === 0 && prev > 3) throw new Error("MyClub returned no events although it normally has some; the reader may be broken");
    ok(ctx, "MyClub", snap.events.length);
  } catch (e) {
    fail(ctx, "MyClub", e);
    return;
  }
  ctx.state.myclub.lastSnapshot = snap;
  const before = ctx.state.changes.length;
  // Events the family said a child will skip stay on the calendar, marked.
  const declined = new Set(ctx.state.myclub.declined ?? []);
  const desired = myclubEvents(snap, ctx.cfg, ctx.now).map((e) => (declined.has(e.sourceId) ? { ...e, title: `${e.title} (not going)` } : e));
  const warnings = await syncInto(ctx, "hobbies", "myclub", desired, ctx.cfg.myclub.horizon_weeks * 7);
  // Same-day cancellations are urgent.
  const today = localParts(ctx.now).date;
  const urgent = ctx.state.changes
    .slice(before)
    .filter((c) => c.kind !== "new" && c.when.startsWith(today))
    .map((c) => `${c.kind === "cancelled" ? "Cancelled" : "Changed"} today: ${c.title} (${c.when})`);
  await sendAlert(ctx, [...urgent, ...warnings]);
}

export async function runOutlook(ctx: Ctx) {
  if (!ctx.mail) return;
  try {
    const wf = ctx.cfg.outlook.wilma_folder;
    if (wf && (await ensureWilmaRule(ctx.mail, wf.name, wf.senders)) === "created") ctx.log(`outlook: created rule filing Wilma mail into "${wf.name}"`);
    const r = await scanInvoices(ctx.mail, ctx.state, ctx.cfg.outlook.scan_lookback_days, ctx.now);
    ok(ctx, "Outlook", r.scanned);
    ctx.log(`outlook: scanned ${r.scanned}, new bills ${r.newBills.length}`);
  } catch (e) {
    fail(ctx, "Outlook", e);
  }
  const a = assistantCtx(ctx);
  if (a) await offerReplies(a).catch((e) => fail(ctx, "Email assistant", e));
}

function assistantCtx(ctx: Ctx): AssistantCtx | undefined {
  const cfg = ctx.cfg.outlook.assistant;
  if (!cfg?.enabled || !ctx.mail?.listInbox || !ctx.notifier?.sendButtons || !privateChat()) return;
  return { cfg: ctx.cfg, state: ctx.state, now: ctx.now, mail: ctx.mail as AssistantMail, notifier: ctx.notifier, writer: cfg.writer === "claude" ? ctx.replyWriter : undefined, chat: privateChat()!, log: ctx.log };
}

/** Henri's Send / Skip presses; read on every tick, whatever else is due. */
export async function runAssistantInbox(ctx: Ctx) {
  const a = assistantCtx(ctx);
  if (a) await handleUpdates(a).catch((e) => fail(ctx, "Email assistant", e));
}

export async function collectHub(ctx: Ctx, days: number): Promise<HubEvent[]> {
  if (!ctx.calendar) return [];
  const today = localParts(ctx.now).date;
  const out: HubEvent[] = [];
  for (const which of ["family", "school", "hobbies"] as const) {
    const id = calId(ctx.cfg, which);
    if (!id) continue;
    try {
      const evs = await ctx.calendar.list(id, { timeMin: fromLocal(today).toISOString(), timeMax: fromLocal(addDays(today, days + 1)).toISOString() });
      out.push(...evs.filter((e) => e.status !== "cancelled").map((e) => toHubEvent(e, which)));
    } catch (e) {
      fail(ctx, `Google calendar (${which})`, e);
    }
  }
  return out;
}

export async function runDigest(ctx: Ctx, weekAhead = false): Promise<string> {
  const cfg = ctx.cfg;
  const today = localParts(ctx.now).date;
  const events = await collectHub(ctx, weekAhead ? 8 : cfg.digest.coming_up_days);
  const bills = cfg.outlook.enabled ? billsToRemind(ctx.state, today, cfg.outlook.remind_days_before) : [];
  const billsPrivately = cfg.outlook.bills_to === "private_if_set" && !!privateChat();
  const html = buildDigest({
    now: ctx.now,
    cfg,
    events,
    wilma: ctx.state.wilma.lastSnapshot as WilmaSnapshot | undefined,
    myclub: ctx.state.myclub.lastSnapshot as MyClubSnapshot | undefined,
    queue: ctx.state.digestQueue,
    changes: ctx.state.changes,
    bills: billsPrivately ? [] : bills,
    health: ctx.state.health,
    weekAhead,
  });
  if (ctx.notifier && familyChat()) await ctx.notifier.send(familyChat()!, html);
  else ctx.log("TELEGRAM_FAMILY_CHAT_ID not set; digest not sent");
  if (billsPrivately && bills.length && ctx.notifier) await ctx.notifier.send(privateChat()!, billsMessage(bills, cfg));
  for (const b of ctx.state.outlook.bills) if (bills.some((x) => x.messageId === b.messageId)) (b.remindedOn ??= []).push(today);
  ctx.state.digestQueue = [];
  ctx.state.lastDigestAt = ctx.now.toISOString();
  return html;
}

// ---------- scheduler ----------

export type JobName = "myclub" | "outlook" | "wilma" | "digest" | "week-ahead" | "attendance-poll" | "attendance-apply";
export interface DueJob {
  job: JobName;
  key: string;
  slot?: RunSlot;
}

/** How late a slot may still run (GitHub's cron can be 10-30 min late). */
const WINDOW_MIN = 75;

export function dueJobs(cfg: Config, state: StateData, now: Date): DueJob[] {
  const lp = localParts(now);
  const due: DueJob[] = [];
  const check = (job: JobName, slot: RunSlot) => {
    if (!slot.days.includes(lp.day)) return;
    const start = toMinutes(slot.time);
    if (lp.minutes < start || lp.minutes >= start + WINDOW_MIN) return;
    const key = `${lp.date} ${slot.time}`;
    if (state.lastRun[`${job}@${slot.time}`] === key) return;
    due.push({ job, key, slot });
  };
  if (cfg.myclub.enabled) cfg.myclub.runs.forEach((s) => check("myclub", s));
  if (cfg.outlook.enabled) cfg.outlook.runs.forEach((s) => check("outlook", s));
  if (cfg.wilma.enabled) cfg.wilma.runs.forEach((s) => check("wilma", s));
  const weekend = lp.day === "sat" || lp.day === "sun";
  check("digest", { days: [lp.day], time: weekend ? cfg.digest.weekend_time : cfg.digest.weekday_time });
  check("week-ahead", { days: [cfg.digest.week_ahead.day], time: cfg.digest.week_ahead.time });
  if (cfg.attendance?.enabled) {
    check("attendance-poll", cfg.attendance.poll);
    check("attendance-apply", cfg.attendance.apply);
  }
  return due;
}

export async function tick(ctx: Ctx, force?: JobName[]) {
  await runAssistantInbox(ctx);
  const jobs: DueJob[] = force
    ? force.map((job) => ({ job, key: `forced ${ctx.now.toISOString()}` }))
    : dueJobs(ctx.cfg, ctx.state, ctx.now);
  if (!jobs.length) {
    ctx.log(`nothing due at ${localParts(ctx.now).date} ${localParts(ctx.now).time} Helsinki`);
    return [];
  }
  // Sources first so the digest sees fresh data.
  const order: JobName[] = ["myclub", "attendance-apply", "outlook", "wilma", "digest", "week-ahead", "attendance-poll"];
  jobs.sort((a, b) => order.indexOf(a.job) - order.indexOf(b.job));
  for (const j of jobs) {
    ctx.log(`running ${j.job} (${j.key})`);
    if (j.job === "myclub") await runMyClub(ctx);
    if (j.job === "outlook") await runOutlook(ctx);
    if (j.job === "wilma") await runWilma(ctx, j.slot);
    if (j.job === "digest") await runDigest(ctx);
    if (j.job === "week-ahead") await runDigest(ctx, true);
    if (j.job === "attendance-poll") await runAttendancePoll(ctx);
    if (j.job === "attendance-apply") await runAttendanceApply(ctx, ctx.attendanceWriter);
    if (j.slot) ctx.state.lastRun[`${j.job}@${j.slot.time}`] = j.key;
  }
  return jobs.map((j) => j.job);
}

/**
 * The laptop fetches Wilma shortly before each Wilma slot, so the GitHub tick
 * at the slot finds a fresh snapshot. Returns the slot key when a fetch is due.
 */
export function wilmaFetchDue(cfg: Config, lastRun: Record<string, string>, now: Date, leadMin = 20): string | undefined {
  const lp = localParts(now);
  for (const slot of cfg.wilma.runs) {
    if (!slot.days.includes(lp.day)) continue;
    const start = toMinutes(slot.time) - leadMin;
    if (lp.minutes < start || lp.minutes >= start + 60) continue;
    const key = `${lp.date} ${slot.time}`;
    if (lastRun[`wilma-fetch@${slot.time}`] === key) continue;
    return key;
  }
}
