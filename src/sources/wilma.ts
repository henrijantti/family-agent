import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { Config, childName, env, requireEnv } from "../config.js";
import type { DesiredEvent } from "../calendar/types.js";
import { decrypt, type StateData } from "../lib/state.js";
import { addDays, daysBetween, localIso, localParts } from "../lib/time.js";
import { totp } from "../lib/totp.js";

// Wilma through @wilm-ai/wilma-client, read-only. One login per run (Wilma
// allows one live session per account), shared by all children; the session
// is saved in state and resumed next run so Henri is logged out less often.

export interface WilmaLesson { date: string; start: string; end: string; subject: string; room?: string | null }
export interface WilmaExam {
  id: number;
  date: string;
  time?: string | null;
  subject: string;
  name: string;
  topic?: string | null;
  /** "Kokeen lisätiedot" from the exam calendar: usually what to read ("kpl 4-8 s. 16-36"). */
  notes?: string | null;
  teacher?: string | null;
}
export interface WilmaHomework { date: string; subject: string; text: string }
export interface WilmaMessage {
  id: number;
  subject: string;
  sender?: string | null;
  sentAt: string;
  /** The message's text with its replies, when read (kept from earlier reads). */
  content?: string | null;
  /** Replies when the text was read: more replies in the list means read it again. */
  replies?: number;
}
export interface WilmaNews { id: number; title: string; published?: string | null; content?: string | null; url?: string }
export interface WilmaNote {
  date: string;
  subject: string;
  type: string;
  /** The teacher's own words from the "Huomioita" column (homework missed, praise, behaviour). */
  note?: string | null;
  teacher?: string | null;
}

export interface WilmaStudent {
  name: string; // display name after config mapping
  number: string;
  lessons: WilmaLesson[];
  exams: WilmaExam[];
  homework: WilmaHomework[];
  messages: WilmaMessage[];
  news: WilmaNews[];
  notes: WilmaNote[];
}

export interface WilmaSnapshot {
  fetchedAt: string;
  baseUrl: string;
  students: WilmaStudent[];
}

export interface WilmaProvider {
  fetch(cfg: Config, state: StateData): Promise<WilmaSnapshot>;
}

/** Message texts are this long at most, kept from run to run in the last snapshot. */
const TEXT_MAX = 8000;
/** Messages this recent always have their text (the chat agents read and draft replies to them). */
const TEXT_DAYS = 14;

export class FixtureWilma implements WilmaProvider {
  constructor(private path: string) {}
  async fetch(cfg: Config): Promise<WilmaSnapshot> {
    const s = JSON.parse(readFileSync(this.path, "utf8")) as WilmaSnapshot;
    s.students = s.students.map((st) => ({ ...st, name: childName(cfg, st.name) }));
    return s;
  }
}

/**
 * Wilma's Cloudflare turns away cloud servers, so a runner on Henri's laptop
 * (home connection) fetches the snapshot and the GitHub-hosted tick reads it
 * here. A snapshot older than `maxAgeHours` counts as a failed read.
 */
export class SnapshotWilma implements WilmaProvider {
  constructor(
    private path: string,
    private secret: string | undefined,
    private now: Date,
    private maxAgeHours = 3,
  ) {}
  async fetch(cfg: Config): Promise<WilmaSnapshot> {
    if (!existsSync(this.path)) throw new Error("no Wilma update from the laptop yet (is the home runner set up and on?)");
    let text = readFileSync(this.path, "utf8");
    if (text.startsWith("FAENC1:")) text = decrypt(text, this.secret ?? "");
    const s = JSON.parse(text) as WilmaSnapshot;
    const ageH = (this.now.getTime() - Date.parse(s.fetchedAt)) / 3600000;
    if (ageH > this.maxAgeHours) throw new Error(`last Wilma update from the laptop is ${Math.round(ageH)} h old (laptop off or asleep?)`);
    s.students = s.students.map((st) => ({ ...st, name: childName(cfg, st.name) }));
    return s;
  }
}

export class LiveWilma implements WilmaProvider {
  async fetch(cfg: Config, state: StateData): Promise<WilmaSnapshot> {
    const { WilmaClient, addExamTimes } = await import("@wilm-ai/wilma-client");
    const baseUrl = normaliseTenant(requireEnv("WILMA_TENANT"));
    const profile = { baseUrl, username: requireEnv("WILMA_USERNAME"), password: requireEnv("WILMA_PASSWORD") };
    const totpSecret = env("WILMA_TOTP_SECRET");
    const onMfa = totpSecret ? async () => totp(totpSecret) : undefined;
    switchWilmaAccount(state, baseUrl, profile.username);

    let client = state.wilma.session ? WilmaClient.resume(profile, state.wilma.session, onMfa) : null;
    client ??= await WilmaClient.login(profile, onMfa);
    client.onLogin(() => (state.wilma.session = client!.exportSession()));
    state.wilma.session = client.exportSession();

    const today = localParts(new Date()).date;
    const prev = (state.wilma.lastSnapshot as WilmaSnapshot | undefined)?.students ?? [];
    const prevMsg = new Map(prev.flatMap((s) => s.messages.map((m) => [m.id, m] as const)));
    const prevNews = new Map(prev.flatMap((s) => s.news.map((n) => [n.id, n] as const)));
    const students: WilmaStudent[] = [];
    for (const info of await client.students()) {
      const kid = client.forStudent(info.studentNumber);
      const [overview, calendar, lessons, messages, news, notes] = await Promise.all([
        kid.overview.get(),
        kid.exams.calendarOrEmpty(),
        kid.schedule.list({ from: today, to: addDays(today, 8) }),
        kid.messages.list("inbox"),
        kid.news.list(),
        kid.attendance.list({ from: addDays(today, -14), to: today }),
      ]);
      // The front page's exams with the exam calendar's start time, notes and teacher.
      // addExamTimes finds each exam's calendar entry and copies its time; the time is
      // swapped for the entry's index so the same matching gives the whole entry.
      const exams = addExamTimes(overview.upcomingExams, calendar.map((c, i) => ({ ...c, time: String(i) }))).map((e) => {
        const c = e.time == null ? undefined : calendar[Number(e.time)];
        return { ...e, time: c?.time ?? null, notes: c?.notes ?? null, teacher: c?.teacher ?? e.teacher };
      });
      // Full text for items not seen before (to spot "reply/form/payment"), and for
      // recent messages without it yet or with new replies; earlier texts are kept.
      const recent = Date.now() - TEXT_DAYS * 86400000;
      const toRead = messages
        .slice(0, 30)
        .filter((m) => {
          const p = prevMsg.get(m.wilmaId);
          return !state.wilma.seenMessages.includes(m.wilmaId) || (m.sentAt.getTime() >= recent && (p?.content == null || (p.replies ?? 0) !== (m.replyCount ?? 0)));
        })
        .slice(0, 10);
      const msgBodies = new Map<number, string>();
      for (const m of toRead) {
        const full = await kid.messages.get(m.wilmaId);
        const replies = (full.replies ?? []).map((r) => `— ${r.senderName ?? "?"}, ${localParts(r.sentAt).date}:\n${r.content}`);
        msgBodies.set(m.wilmaId, [full.content ?? "", ...replies].filter(Boolean).join("\n\n").slice(0, TEXT_MAX));
      }
      // Every kept bulletin needs its text: the School calendar's bulletin events take
      // their dates from it, and an event whose date disappears gets deleted. Texts
      // are kept from run to run, so after the first run only new ones are read.
      const newNews = news.slice(0, 30).filter((n) => !n.content && prevNews.get(n.wilmaId)?.content == null);
      const newsBodies = new Map<number, string | null | undefined>();
      for (const n of newNews) newsBodies.set(n.wilmaId, (await kid.news.get(n.wilmaId)).content);

      students.push({
        name: childName(cfg, info.name),
        number: info.studentNumber,
        lessons: lessons.map((l) => ({ date: l.date, start: l.start, end: l.end, subject: l.subject, room: l.room })),
        exams: exams.map((e) => ({ id: e.examId, date: e.date, time: e.time, subject: e.subject, name: e.name, topic: e.topic, notes: e.notes, teacher: e.teacher })),
        homework: overview.homework.map((h) => ({ date: h.date, subject: h.subject, text: h.homework })),
        messages: messages.slice(0, 30).map((m) => ({
          id: m.wilmaId,
          subject: m.subject,
          sender: m.senderName,
          sentAt: m.sentAt.toISOString(),
          content: msgBodies.get(m.wilmaId) ?? prevMsg.get(m.wilmaId)?.content ?? null,
          replies: msgBodies.has(m.wilmaId) ? (m.replyCount ?? 0) : prevMsg.get(m.wilmaId)?.replies,
        })),
        news: news.slice(0, 30).map((n) => ({
          id: n.wilmaId,
          title: n.title,
          published: n.published?.toISOString() ?? null,
          content: (newsBodies.get(n.wilmaId) ?? n.content ?? prevNews.get(n.wilmaId)?.content ?? null)?.slice(0, TEXT_MAX) ?? null,
          url: `${baseUrl}/news/${n.wilmaId}`,
        })),
        notes: notes.map((n) => ({ date: n.date, subject: n.subject, type: n.typeLabel, note: n.note ?? null, teacher: n.teacher })),
        // Grades are never fetched unless include_grades is on; even then they stay out of Telegram.
      });
    }
    return { fetchedAt: new Date().toISOString(), baseUrl, students };
  }
}

/**
 * A new Wilma login (e.g. Henri's account swapped for Anna's, 2026-10-25) must
 * not resume the old account's session, and its messages would all look new.
 * Forget the session and seen items so the next run learns silently.
 */
export function switchWilmaAccount(state: StateData, baseUrl: string, username: string): boolean {
  const account = createHash("sha256").update(`${baseUrl}|${username.toLowerCase()}`).digest("hex").slice(0, 16);
  const w = state.wilma;
  if (w.account === account) return false;
  const had = w.account !== undefined || !!w.session; // a session saved before this field existed counts as another login
  w.account = account;
  if (!had) return false;
  delete w.session;
  w.seenMessages = [];
  w.seenNews = [];
  w.seenNotes = [];
  w.exams = {};
  return true;
}

export function normaliseTenant(t: string): string {
  const url = t.startsWith("http") ? t : `https://${t}`;
  return url.replace(/\/+$/, "");
}

// ---------- pure logic, tested on fixtures ----------

const ACTION_WORDS = [
  "vastaa", "vastaus", "palauta", "palautus", "lupa", "lupalap", "allekirjoit", "kuittaa", "ilmoittaudu", "ilmoittautu",
  "lomake", "maksu", "maksa", "€", "reply", "respond", "form", "sign", "payment", "permission", "deadline", "rsvp",
];

export function needsAction(text: string): boolean {
  const t = text.toLowerCase();
  return ACTION_WORDS.some((w) => t.includes(w));
}

/** Dated items in bulletin text: "12.11.", "12.11.2026", "ke 12.11. klo 18-19.30". */
export function datesInText(text: string, today: string): { date: string; start?: string; end?: string }[] {
  const out: { date: string; start?: string; end?: string }[] = [];
  const re = /\b(\d{1,2})\.(\d{1,2})\.(\d{4}|\d{2})?(?:\s*(?:klo|kello|at)?\s*(\d{1,2})(?:[.:](\d{2}))?(?:\s*[-–]\s*(\d{1,2})(?:[.:](\d{2}))?)?)?/gi;
  const year = Number(today.slice(0, 4));
  for (const m of text.matchAll(re)) {
    const d = Number(m[1]);
    const mo = Number(m[2]);
    if (d < 1 || d > 31 || mo < 1 || mo > 12) continue;
    let y = m[3] ? Number(m[3].length === 2 ? `20${m[3]}` : m[3]) : year;
    let date = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    if (!m[3] && date < today) date = `${(y = year + 1)}-${date.slice(5)}`; // "12.1." in November means next year
    const ahead = daysBetween(today, date);
    if (ahead < 0 || ahead > 120) continue;
    const hasClock = /klo|kello|at/i.test(m[0]) && m[4];
    const start = hasClock ? `${m[4].padStart(2, "0")}:${m[5] ?? "00"}` : undefined;
    const end = hasClock && m[6] ? `${m[6].padStart(2, "0")}:${m[7] ?? "00"}` : undefined;
    if (!out.some((o) => o.date === date)) out.push({ date, start, end });
  }
  return out;
}

export function wilmaEvents(snap: WilmaSnapshot, cfg: Config, today: string): DesiredEvent[] {
  const events: DesiredEvent[] = [];
  for (const st of snap.students) {
    for (const ex of st.exams) {
      if (ex.date < today) continue;
      // Always "koe": a named exam ("Kirkkohistoria jakso 1") must still read as an exam to
      // the digest's Tulossa, the dashboard and the chat bots (Henri, 2026-10-25).
      const named = ex.name && ex.name !== ex.subject && !/^(koe|exam)$/i.test(ex.name.trim());
      const what = `${ex.subject || ex.name} koe${named ? ` (${ex.name})` : ""}`;
      const title = `${st.name}: ${what}${ex.topic ? `: ${ex.topic}` : ""}`;
      const timed = !!ex.time;
      events.push({
        source: "wilma",
        sourceId: `exam:${st.number}:${ex.id}`,
        title,
        start: timed ? { dateTime: localIso(ex.date, ex.time!), timeZone: cfg.timezone } : { date: ex.date },
        end: timed ? { dateTime: localIso(ex.date, addMinutes(ex.time!, 75)), timeZone: cfg.timezone } : { date: addDays(ex.date, 1) },
        description: [ex.notes ? `Kokeen lisätiedot: ${ex.notes}` : "", ex.teacher ? `Opettaja: ${ex.teacher}` : ""].filter(Boolean).join("\n") || undefined,
        url: `${snap.baseUrl}/exams/calendar`,
        reminderMinutes: timed ? 18 * 60 : 6 * 60, // the evening before
      });
    }
  }
  if (cfg.wilma.bulletin_events) {
    // A bulletin seen by several children of the same school becomes one event.
    const byNews = new Map<number, { item: WilmaNews; kids: string[] }>();
    for (const st of snap.students)
      for (const n of st.news) {
        const e = byNews.get(n.id) ?? { item: n, kids: [] };
        if (!e.kids.includes(st.name)) e.kids.push(st.name);
        byNews.set(n.id, e);
      }
    for (const { item, kids } of byNews.values()) {
      for (const d of datesInText(`${item.title}\n${item.content ?? ""}`, today)) {
        const timed = !!d.start;
        events.push({
          source: "wilma",
          sourceId: `news:${item.id}:${d.date}`,
          title: `${kids.join(" & ")}: ${item.title} (from bulletin)`,
          start: timed ? { dateTime: localIso(d.date, d.start!), timeZone: cfg.timezone } : { date: d.date },
          end: timed
            ? { dateTime: localIso(d.date, d.end ?? addMinutes(d.start!, 60)), timeZone: cfg.timezone }
            : { date: addDays(d.date, 1) },
          description: "Date read from bulletin text by the agent; check the original.",
          url: item.url,
          tentative: true,
        });
      }
    }
  }
  return events;
}

function addMinutes(hhmm: string, n: number): string {
  const [h, m] = hhmm.split(":").map(Number);
  const t = Math.min(h * 60 + m + n, 23 * 60 + 59);
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
}

export interface WilmaNews2Digest {
  child: string;
  kind: "message" | "bulletin" | "note";
  text: string;
  action: boolean;
}

export interface WilmaDiff {
  fresh: WilmaNews2Digest[];
  examAlerts: string[];
}

/** New messages, bulletins, notes and exam moves since last run; updates state. */
export function wilmaDiff(snap: WilmaSnapshot, state: StateData, cfg: Config, today: string): WilmaDiff {
  const w = state.wilma;
  const first = w.seenMessages.length === 0 && w.seenNews.length === 0 && Object.keys(w.exams).length === 0;
  const fresh: WilmaNews2Digest[] = [];
  const examAlerts: string[] = [];
  const seenMsg = new Set(w.seenMessages);
  const seenNews = new Set(w.seenNews);
  const seenNotes = new Set(w.seenNotes);
  for (const st of snap.students) {
    for (const m of st.messages) {
      if (seenMsg.has(m.id)) continue;
      seenMsg.add(m.id);
      if (!first) fresh.push({ child: st.name, kind: "message", text: `${m.subject}${m.sender ? ` (${m.sender})` : ""}`, action: needsAction(`${m.subject} ${m.content ?? ""}`) });
    }
    for (const n of st.news) {
      if (seenNews.has(n.id)) continue;
      seenNews.add(n.id);
      if (!first) fresh.push({ child: st.name, kind: "bulletin", text: n.title, action: needsAction(`${n.title} ${n.content ?? ""}`) });
    }
    for (const n of st.notes) {
      const key = `${st.number}:${n.date}:${n.subject}:${n.type}`;
      if (seenNotes.has(key)) continue;
      seenNotes.add(key);
      // Summarised, never the teacher's own words (privacy rule from the plan).
      if (!first) fresh.push({ child: st.name, kind: "note", text: `${n.type}, ${n.subject} (${n.date})`, action: false });
    }
    for (const ex of st.exams) {
      const key = `${st.number}:${ex.id}`;
      const prev = w.exams[key];
      const soon = daysBetween(today, ex.date) <= cfg.alerts.exam_soon_days && ex.date >= today;
      if (!first && soon && prev !== ex.date) examAlerts.push(`${st.name}: ${ex.subject} exam ${prev ? `moved to` : "added for"} ${ex.date}`);
      w.exams[key] = ex.date;
    }
  }
  w.seenMessages = [...seenMsg].slice(-500);
  w.seenNews = [...seenNews].slice(-500);
  w.seenNotes = [...seenNotes].slice(-1000);
  // Drop past exams from the snapshot memory.
  for (const [k, d] of Object.entries(w.exams)) if (d < addDays(today, -7)) delete w.exams[k];
  return { fresh, examAlerts };
}
