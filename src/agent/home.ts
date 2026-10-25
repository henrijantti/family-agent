import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CalendarApi, CalendarEvent } from "../calendar/types.js";
import { Config } from "../config.js";
import { calId } from "../jobs.js";
import { withLock } from "../lib/lock.js";
import { addDays, daysBetween, localIso, localParts } from "../lib/time.js";
import type { DriveApi } from "../lib/drive-user.js";
import { CHAT_TAG } from "./family-tools.js";
import { Tool, ToolError } from "./mcp.js";

// Henri's household register, for the Chief of staff only (the family server
// without --group): reminders for the car, the home, documents, contracts and
// birthdays; family papers kept as files with their deadlines; and the school
// holidays for trip planning. Each reminder also gets an all-day event on the
// "Anna Henri" calendar, tagged as a chat event so the sync never touches it.
// Everything lives in one JSON file next to the state, written under a lock;
// nothing here sends a message: the scheduled prompt posts what reminders_due returns.

const DATE = "^\\d{4}-\\d{2}-\\d{2}$";
const KINDS = ["upkeep", "birthday", "document", "contract", "paper", "other"] as const;
type Kind = (typeof KINDS)[number];
/** Days ahead of the due date for the first reminder, per kind (passports need time). */
const LEAD: Record<Kind, number> = { upkeep: 30, birthday: 14, document: 60, contract: 30, paper: 14, other: 7 };
const PAPER_KINDS = ["receipt", "warranty", "insurance", "contract", "form", "certificate", "other"] as const;
const PAPER_LABEL: Record<string, string> = {
  receipt: "kuitti",
  warranty: "takuu päättyy",
  insurance: "vakuutus uusiutuu",
  contract: "sopimus päättyy",
  form: "lomakkeen määräaika",
  certificate: "todistus vanhenee",
  other: "määräaika",
};
const MAX_PAPER_BYTES = 20 * 1024 * 1024;
/** OpenClaw stores inbound media as <name>---<uuid>.<ext> or <uuid>.<ext>. */
const MEDIA_NAME = /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,150}$/u;

export interface Reminder {
  id: string;
  kind: Kind;
  title: string;
  due: string;
  /** Repeats this many months after each due date (12 = yearly). */
  everyMonths?: number;
  remindDays: number;
  notes?: string;
  /** Birthdays: whose, and the year born when known (for the age). */
  person?: string;
  born?: number;
  paperId?: string;
  calendarEventId?: string;
  /** Henri pressed "later": quiet until this day, then told once more. */
  snoozeUntil?: string;
  status: "open" | "done" | "removed";
  /** Reminder stages already reported, as "<due>:<stage>". */
  notified: string[];
  done: string[];
  createdAt: string;
}

export interface Paper {
  id: string;
  kind: (typeof PAPER_KINDS)[number];
  title: string;
  date?: string;
  amount?: string;
  expires?: string;
  notes?: string;
  file: string;
  mime: string;
  sha256: string;
  driveFileId?: string;
  driveLink?: string;
  reminderId?: string;
  savedAt: string;
}

interface HomeData {
  reminders: Reminder[];
  papers: Paper[];
  driveFolderId?: string;
}

export interface HomeDeps {
  cfg: Config;
  calendar?: CalendarApi;
  /** home.json, next to the state file. Papers go in papers/ beside it. */
  file: string;
  /** OpenClaw's inbound media folder (~/.openclaw/media/inbound). */
  mediaDir?: string;
  drive?: DriveApi;
  now(): Date;
}

function load(d: HomeDeps): HomeData {
  if (!existsSync(d.file)) return { reminders: [], papers: [] };
  return JSON.parse(readFileSync(d.file, "utf8")) as HomeData;
}

function save(d: HomeDeps, data: HomeData) {
  mkdirSync(dirname(d.file), { recursive: true });
  const tmp = `${d.file}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 1), { mode: 0o600 });
  renameSync(tmp, d.file);
}

async function change<T>(d: HomeDeps, fn: (data: HomeData) => Promise<T>): Promise<T> {
  return withLock(d.file, async () => {
    const data = load(d);
    const out = await fn(data);
    save(d, data);
    return out;
  });
}

const today = (d: HomeDeps) => localParts(d.now()).date;
const newId = (prefix: string) => `${prefix}${randomBytes(6).toString("hex")}`;

/** Same day n months later; the 31st becomes the month's last day. */
export function addMonths(date: string, n: number): string {
  const [y, m, day] = date.split("-").map(Number);
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${String(nm).padStart(2, "0")}-${String(Math.min(day, last)).padStart(2, "0")}`;
}

function familyCal(d: HomeDeps): { api: CalendarApi; id: string } | undefined {
  const id = calId(d.cfg, "family");
  return d.calendar && id ? { api: d.calendar, id } : undefined;
}

function calendarTitle(r: Reminder): string {
  if (r.kind === "birthday") return `${r.person ?? r.title}: syntymäpäivä${r.born ? ` (${Number(r.due.slice(0, 4)) - r.born} v)` : ""}`;
  return r.title;
}

async function putOnCalendar(d: HomeDeps, r: Reminder) {
  const c = familyCal(d);
  if (!c) return;
  const ev: CalendarEvent = {
    id: r.calendarEventId ?? `chat${randomBytes(12).toString("hex")}`,
    summary: calendarTitle(r),
    start: { date: r.due },
    end: { date: addDays(r.due, 1) },
    transparency: "transparent",
    description: [r.notes, "Muistutus Chief of staffilta."].filter(Boolean).join("\n\n"),
    extendedProperties: { private: { agent: CHAT_TAG, reminder: r.id, createdAt: d.now().toISOString() } },
  };
  if (r.calendarEventId) await c.api.update(c.id, r.calendarEventId, ev);
  else r.calendarEventId = (await c.api.insert(c.id, ev)).id;
}

async function offCalendar(d: HomeDeps, r: Reminder) {
  const c = familyCal(d);
  if (c && r.calendarEventId) await c.api.delete(c.id, r.calendarEventId).catch(() => {});
}

function view(d: HomeDeps, r: Reminder) {
  return {
    id: r.id,
    kind: r.kind,
    title: r.title,
    due: r.due,
    inDays: daysBetween(today(d), r.due),
    repeats: r.everyMonths ? (r.everyMonths === 12 ? "yearly" : `every ${r.everyMonths} months`) : undefined,
    remindDays: r.remindDays,
    person: r.person,
    age: r.kind === "birthday" && r.born ? Number(r.due.slice(0, 4)) - r.born : undefined,
    notes: r.notes,
    paperId: r.paperId,
    onCalendar: !!r.calendarEventId,
    status: r.status,
  };
}

/** Which reminder stage a day count falls in: the first notice, a week, the day before, the day, then weekly when overdue. */
export function stage(daysLeft: number, remindDays: number): string | undefined {
  if (daysLeft < 0) return `over${Math.floor(-daysLeft / 7)}`;
  if (daysLeft === 0) return "day";
  if (daysLeft === 1) return "1";
  if (daysLeft <= 7 && remindDays > 7) return "7";
  if (daysLeft <= remindDays) return "lead";
  return undefined;
}

async function addReminder(d: HomeDeps, data: HomeData, a: Partial<Reminder> & { kind: Kind; title: string; due: string }, calendar = true): Promise<Reminder> {
  const dup = data.reminders.find((r) => r.status === "open" && r.title === a.title && r.due === a.due);
  if (dup) return dup;
  const r: Reminder = {
    id: newId("r"),
    kind: a.kind,
    title: a.title,
    due: a.due,
    everyMonths: a.kind === "birthday" ? 12 : a.everyMonths,
    remindDays: a.remindDays ?? LEAD[a.kind],
    notes: a.notes,
    person: a.person,
    born: a.born,
    paperId: a.paperId,
    status: "open",
    notified: [],
    done: [],
    createdAt: d.now().toISOString(),
  };
  // A birthday given as the birth date (or any past date) moves to the next one.
  if (r.everyMonths) while (r.due < today(d)) r.due = addMonths(r.due, r.everyMonths);
  if (calendar) await putOnCalendar(d, r);
  data.reminders.push(r);
  return r;
}

function find(data: HomeData, id: string): Reminder {
  const r = data.reminders.find((x) => x.id === id && x.status !== "removed");
  if (!r) throw new ToolError(`no reminder ${id}; reminder_list shows the ids`);
  return r;
}

/** Resolves an OpenClaw inbound media reference to a file in the inbound folder, refusing anything else. */
export function inboundFile(mediaDir: string, ref: string): string {
  const m = ref.trim().match(/^(?:media:\/\/inbound\/)?([^/\\]+)$/);
  if (!m || !MEDIA_NAME.test(m[1]) || m[1].includes("..")) throw new ToolError('media must be the "media://inbound/<file>" reference from the attachment line');
  const path = join(mediaDir, m[1]);
  if (!existsSync(path)) throw new ToolError(`no attachment ${m[1]} (it may have expired; ask Henri to send it again)`);
  const st = lstatSync(path);
  if (!st.isFile()) throw new ToolError("not a regular file");
  if (st.size > MAX_PAPER_BYTES) throw new ToolError("file is over 20 MB");
  return path;
}

/** The file type from its first bytes; only documents and photos are kept. */
export function sniff(buf: Buffer): { mime: string; ext: string } {
  if (buf.subarray(0, 5).toString("latin1") === "%PDF-") return { mime: "application/pdf", ext: "pdf" };
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: "image/jpeg", ext: "jpg" };
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: "image/png", ext: "png" };
  if (buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") return { mime: "image/webp", ext: "webp" };
  if (buf.subarray(4, 8).toString("latin1") === "ftyp" && /^(heic|heix|mif1|msf1)$/.test(buf.subarray(8, 12).toString("latin1"))) return { mime: "image/heic", ext: "heic" };
  throw new ToolError("only PDFs and photos (JPEG, PNG, WebP, HEIC) can be saved as papers");
}

function slug(s: string): string {
  const map: Record<string, string> = { ä: "a", ö: "o", å: "a" };
  return s.toLowerCase().replace(/[äöå]/g, (c) => map[c]).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "paperi";
}

export interface Holiday {
  name: string;
  from: string;
  to: string;
}

export function homeTools(d: HomeDeps): Tool[] {
  const mediaDir = d.mediaDir ?? join(homedir(), ".openclaw", "media", "inbound");
  const reminderFields = {
    title: { type: "string" as const, maxLength: 200, description: 'Finnish, what and whose, e.g. "Auto: katsastus", "Oskar: passi vanhenee", "Kotivakuutus uusiutuu"' },
    due: { type: "string" as const, pattern: DATE, description: "YYYY-MM-DD, the day it is due (a birthday: the birth date or the next birthday)" },
    everyMonths: { type: "integer" as const, description: "repeats after this many months (12 = yearly, 6 = tyres twice a year); leave out for once. Birthdays are always yearly" },
    remindDays: { type: "integer" as const, description: "first reminder this many days before; default by kind: upkeep 30, birthday 14, document 60, contract 30, paper 14, other 7" },
    notes: { type: "string" as const, maxLength: 1000 },
  };
  return [
    {
      name: "reminder_add",
      description:
        "Add a reminder for the household: car and home upkeep (katsastus, renkaanvaihto, huolto), documents (passports, ID cards), contracts and insurance renewals, birthdays, or anything else with a date. It also goes on the Anna Henri calendar as an all-day event (calendar: false to skip). The Chief of staff reminds Henri ahead of time, again a week and a day before, and weekly when overdue. Returns the existing one if the same title and date is already there.",
      input: {
        properties: {
          kind: { type: "string", enum: [...KINDS] },
          ...reminderFields,
          person: { type: "string", maxLength: 80, description: "birthdays: whose (e.g. Mummi, Oskar)" },
          born: { type: "integer", description: "birthdays: the year born, when known" },
          calendar: { type: "boolean", description: "default true" },
        },
        required: ["kind", "title", "due"],
      },
      async run(a) {
        if (a.everyMonths !== undefined && ((a.everyMonths as number) < 1 || (a.everyMonths as number) > 120)) throw new ToolError("everyMonths must be 1-120");
        if (a.remindDays !== undefined && ((a.remindDays as number) < 0 || (a.remindDays as number) > 365)) throw new ToolError("remindDays must be 0-365");
        return change(d, async (data) => view(d, await addReminder(d, data, a as never, a.calendar !== false)));
      },
    },
    {
      name: "reminder_list",
      description: "The household reminders, soonest first. Read-only.",
      input: {
        properties: {
          kind: { type: "string", enum: [...KINDS] },
          within: { type: "integer", description: "only those due within this many days (overdue included)" },
          all: { type: "boolean", description: "include done ones" },
        },
      },
      async run(a) {
        return load(d)
          .reminders.filter((r) => r.status === "open" || (a.all && r.status === "done"))
          .filter((r) => !a.kind || r.kind === a.kind)
          .map((r) => view(d, r))
          .filter((r) => a.within === undefined || r.inDays <= (a.within as number))
          .sort((x, y) => x.due.localeCompare(y.due));
      },
    },
    {
      name: "reminder_update",
      description: "Change a reminder: only the fields given change. The calendar event moves with it.",
      input: { properties: { id: { type: "string", maxLength: 40 }, ...reminderFields }, required: ["id"] },
      async run(a) {
        return change(d, async (data) => {
          const r = find(data, a.id as string);
          for (const k of ["title", "due", "everyMonths", "remindDays", "notes"] as const) if (a[k] !== undefined) (r as unknown as Record<string, unknown>)[k] = a[k];
          if (r.calendarEventId) await putOnCalendar(d, r);
          return view(d, r);
        });
      },
    },
    {
      name: "reminder_done",
      description:
        "Mark a reminder done (Henri says it's handled). A repeating one moves to its next date, and so does its calendar event; a one-off one stays on the calendar as it was.",
      input: { properties: { id: { type: "string", maxLength: 40 }, on: { type: "string", pattern: DATE, description: "the day it was done, default today; a repeating reminder counts its next date from here when that is later than the due date" } }, required: ["id"] },
      async run(a) {
        return change(d, async (data) => {
          const r = find(data, a.id as string);
          const on = (a.on as string) ?? today(d);
          r.done.push(on);
          if (!r.everyMonths) {
            r.status = "done";
            return { status: "done", reminder: view(d, r) };
          }
          let next = addMonths(on > r.due ? on : r.due, r.everyMonths);
          while (next <= today(d)) next = addMonths(next, r.everyMonths);
          r.due = next;
          r.notified = [];
          delete r.snoozeUntil;
          if (r.calendarEventId) await putOnCalendar(d, r);
          return { status: "next", reminder: view(d, r) };
        });
      },
    },
    {
      name: "reminder_remove",
      description: "Stop a reminder that is no longer needed, and take its event off the calendar (cancelled, not a permanent delete).",
      input: { properties: { id: { type: "string", maxLength: 40 } }, required: ["id"] },
      async run(a) {
        return change(d, async (data) => {
          const r = find(data, a.id as string);
          r.status = "removed";
          await offCalendar(d, r);
          return { status: "removed", id: r.id, title: r.title };
        });
      },
    },
    {
      name: "reminders_due",
      description:
        "What to remind Henri about today: reminders reaching their first notice, a week, the day before or the day, and overdue ones once a week. Birthdays that have passed move to next year on their own. mark: true (the scheduled morning prompt) records them as told, so each stage is told once.",
      input: { properties: { mark: { type: "boolean" } } },
      async run(a) {
        const body = async (data: HomeData) => {
          const t = today(d);
          for (const r of data.reminders.filter((x) => x.status === "open" && x.kind === "birthday" && x.due < t)) {
            while (r.due < t) r.due = addMonths(r.due, 12);
            r.notified = [];
            if (a.mark && r.calendarEventId) await putOnCalendar(d, r);
          }
          const out = [];
          for (const r of data.reminders.filter((x) => x.status === "open")) {
            if (r.snoozeUntil && t < r.snoozeUntil) continue;
            const s = r.snoozeUntil ? `snoozed${r.snoozeUntil}` : stage(daysBetween(t, r.due), r.remindDays);
            if (!s || r.notified.includes(`${r.due}:${s}`)) continue;
            out.push({ ...view(d, r), stage: s, giftIdeas: r.kind === "birthday" ? `brain_search "Lahjaidea: ${r.person ?? r.title}"` : undefined });
            if (a.mark) {
              r.notified.push(`${r.due}:${s}`);
              // The snoozed notice stands in for today's ordinary stage, so it isn't told twice.
              if (r.snoozeUntil) r.notified.push(`${r.due}:${stage(daysBetween(t, r.due), r.remindDays)}`);
              delete r.snoozeUntil;
            }
          }
          return out.sort((x, y) => x.due.localeCompare(y.due));
        };
        return a.mark ? change(d, body) : body(load(d));
      },
    },
    {
      name: "reminder_snooze",
      description: "Henri pressed \"later\" on a reminder: keep it quiet for some days, then remind once more (and the usual stages after that).",
      input: { properties: { id: { type: "string", maxLength: 40 }, days: { type: "integer", description: "1-30, default 3" } }, required: ["id"] },
      async run(a) {
        const days = (a.days as number | undefined) ?? 3;
        if (days < 1 || days > 30) throw new ToolError("days must be 1-30");
        return change(d, async (data) => {
          const r = find(data, a.id as string);
          r.snoozeUntil = addDays(today(d), days);
          return { status: "snoozed", until: r.snoozeUntil, reminder: view(d, r) };
        });
      },
    },
    {
      name: "paper_save",
      description:
        "Keep a family paper Henri sent as a photo or PDF: receipt, warranty, insurance, contract, form or certificate. Saves the file on the server and in the \"Perheen paperit\" folder of Henri's Google Drive, and with a date in `expires` (warranty end, renewal, form deadline) adds a reminder and a calendar event. media = the media://inbound/... reference from the attachment line. Saving the same file twice returns the first copy.",
      input: {
        properties: {
          media: { type: "string", maxLength: 300, description: "media://inbound/<file> from the [media attached: ...] line" },
          kind: { type: "string", enum: [...PAPER_KINDS] },
          title: { type: "string", maxLength: 160, description: 'Finnish, short, e.g. "Astianpesukone Gigantti", "Oskar: leirin ilmoittautuminen"' },
          date: { type: "string", pattern: DATE, description: "date on the paper (purchase, signing)" },
          amount: { type: "string", maxLength: 40, description: 'as printed, e.g. "549,00 €"' },
          expires: { type: "string", pattern: DATE, description: "warranty end, renewal or deadline: becomes a reminder" },
          remindDays: { type: "integer", description: "first reminder this many days before expires; default 14 (warranty 30)" },
          notes: { type: "string", maxLength: 1000 },
        },
        required: ["media", "kind", "title"],
      },
      async run(a) {
        const path = inboundFile(mediaDir, a.media as string);
        const buf = readFileSync(path);
        const { mime, ext } = sniff(buf);
        const sha256 = createHash("sha256").update(buf).digest("hex");
        return change(d, async (data) => {
          const same = data.papers.find((p) => p.sha256 === sha256);
          if (same) return { status: "already saved", paper: same };
          const id = newId("p");
          const year = ((a.date as string) ?? today(d)).slice(0, 4);
          const rel = `papers/${year}/${id}-${slug(a.title as string)}.${ext}`;
          const dest = join(dirname(d.file), rel);
          mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
          writeFileSync(dest, buf, { mode: 0o600 });
          chmodSync(dest, 0o600);
          const p: Paper = {
            id,
            kind: a.kind as Paper["kind"],
            title: a.title as string,
            date: a.date as string | undefined,
            amount: a.amount as string | undefined,
            expires: a.expires as string | undefined,
            notes: a.notes as string | undefined,
            file: rel,
            mime,
            sha256,
            savedAt: d.now().toISOString(),
          };
          let drive = "not signed in to Drive yet: kept on the server only";
          if (d.drive) {
            try {
              data.driveFolderId ??= await d.drive.createFolder("Perheen paperit");
              const up = await d.drive.upload(data.driveFolderId, `${p.date ?? year} ${p.title}.${ext}`, mime, buf);
              p.driveFileId = up.id;
              p.driveLink = up.link;
              drive = "saved";
            } catch (e) {
              drive = `failed: ${(e as Error).message}; kept on the server`;
            }
          }
          if (p.expires) {
            const r = await addReminder(d, data, {
              kind: "paper",
              title: `${p.title}: ${PAPER_LABEL[p.kind]}`,
              due: p.expires,
              remindDays: (a.remindDays as number | undefined) ?? (p.kind === "warranty" ? 30 : 14),
              notes: p.driveLink ? `Paperi: ${p.driveLink}` : undefined,
              paperId: p.id,
            });
            p.reminderId = r.id;
          }
          data.papers.push(p);
          return { status: "saved", drive, paper: p };
        });
      },
    },
    {
      name: "paper_list",
      description: "Find saved family papers by words in the title or notes, or by kind. Returns their dates, amounts, deadlines and Drive links. Read-only.",
      input: {
        properties: {
          query: { type: "string", maxLength: 100 },
          kind: { type: "string", enum: [...PAPER_KINDS] },
        },
      },
      async run(a) {
        const words = ((a.query as string) ?? "").toLowerCase().split(/\s+/).filter(Boolean);
        return load(d)
          .papers.filter((p) => !a.kind || p.kind === a.kind)
          .filter((p) => words.every((w) => `${p.title} ${p.notes ?? ""} ${p.amount ?? ""}`.toLowerCase().includes(w)))
          .map(({ sha256: _s, file: _f, ...p }) => p)
          .sort((x, y) => (y.date ?? y.savedAt).localeCompare(x.date ?? x.savedAt));
      },
    },
    {
      name: "holiday_plan",
      description:
        "School holidays ahead (Helsinki schools: syysloma, joululoma, talviloma, kesäloma) with the weekends around them, and what is already on the family, school and hobbies calendars in each: games, tournaments, practices, plans. For trip and holiday planning: which days are free, what clashes. Read-only.",
      input: { properties: { months: { type: "integer", description: "how far ahead, 1-18; default 12" } } },
      async run(a) {
        const t = today(d);
        const until = addMonths(t, Math.min(Math.max((a.months as number | undefined) ?? 12, 1), 18));
        const holidays = (d.cfg.school_holidays ?? []).filter((h) => h.to >= t && h.from <= until);
        if (!holidays.length) throw new ToolError("no school holidays in config for this period (config school_holidays)");
        const out = [];
        for (const h of holidays) {
          // From the Saturday before to the Sunday after, the way families travel.
          const dow = (x: string) => new Date(`${x}T12:00:00Z`).getUTCDay();
          const from = dow(h.from) === 1 ? addDays(h.from, -2) : h.from;
          const to = dow(h.to) === 5 ? addDays(h.to, 2) : h.to;
          const events: { calendar: string; date: string; title: string; start: string }[] = [];
          if (d.calendar && daysBetween(from, to) <= 62) {
            for (const which of ["family", "school", "hobbies"] as const) {
              const id = calId(d.cfg, which);
              if (!id) continue;
              const evs = await d.calendar.list(id, { timeMin: localIso(from, "00:00"), timeMax: localIso(addDays(to, 1), "00:00") });
              for (const e of evs.filter((x) => x.status !== "cancelled")) {
                const start = "date" in e.start ? e.start.date : e.start.dateTime;
                events.push({ calendar: which, date: "date" in e.start ? e.start.date : localParts(new Date(e.start.dateTime)).date, title: e.summary ?? "", start });
              }
            }
          }
          const busy = new Set(events.map((e) => e.date));
          const days = Array.from({ length: daysBetween(from, to) + 1 }, (_, i) => addDays(from, i));
          out.push({
            name: h.name,
            schoolOff: { from: h.from, to: h.to },
            withWeekends: { from, to, days: days.length },
            freeDays: days.filter((x) => !busy.has(x)),
            events: events.sort((x, y) => x.start.localeCompare(y.start)),
            calendarChecked: daysBetween(from, to) <= 62 ? true : "too long to list (summer): check calendar_list for the weeks you plan",
          });
        }
        return { today: t, holidays: out };
      },
    },
  ];
}
