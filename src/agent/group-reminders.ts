import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { withLock } from "../lib/lock.js";
import { fromLocal, localParts } from "../lib/time.js";
import { Notifier, esc } from "../notify/telegram.js";
import { Tool, ToolError } from "./mcp.js";

// One-off reminder messages to the family group, asked for in chat ("muistuta
// ryhmää torstaina klo 7"). The family bot only queues them; the 15-minute
// tick posts the due ones, so a reminder arrives at most a tick late. Nothing
// here sends anything when the tool is called.

export interface GroupReminder {
  id: string;
  /** Helsinki local "YYYY-MM-DD HH:MM". */
  at: string;
  text: string;
  createdAt: string;
  status: "pending" | "sent" | "cancelled" | "missed";
  sentAt?: string;
}

export interface GroupReminderDeps {
  /** group-reminders.json, next to the state file. */
  file: string;
  now(): Date;
}

/** Waking hours only: a family-group ping at night helps nobody. */
const EARLIEST = "06:00";
const LATEST = "22:00";
const MAX_PENDING = 20;
const MAX_DAYS = 120;
/** A reminder more than this late (the server was down) is dropped, not sent stale. */
const LATE_MS = 6 * 3600_000;

function load(file: string): GroupReminder[] {
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as GroupReminder[]) : [];
}

function save(file: string, list: GroupReminder[]) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(list, null, 1), { mode: 0o600 });
  renameSync(tmp, file);
}

const change = <T>(file: string, fn: (list: GroupReminder[]) => T | Promise<T>) =>
  withLock(file, async () => {
    const list = load(file);
    const out = await fn(list);
    save(file, list);
    return out;
  });

const atDate = (r: GroupReminder) => fromLocal(r.at.slice(0, 10), r.at.slice(11));
const view = ({ id, at, text, status, sentAt }: GroupReminder) => ({ id, at, text, status, ...(sentAt ? { sentAt } : {}) });

export function groupReminderTools(d: GroupReminderDeps): Tool[] {
  return [
    {
      name: "group_reminder_add",
      description:
        "Schedule a one-off reminder message to the family Telegram group at a given Helsinki date and time (06:00-22:00, up to 120 days ahead). The server posts it as \"⏰ Muistutus: <text>\" within 15 minutes after the time. Use it when someone asks the group to be reminded of something; a calendar event alone sends no message. Returns the existing one if the same time and text is already queued.",
      input: {
        properties: {
          date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "YYYY-MM-DD, Helsinki" },
          time: { type: "string", pattern: "^\\d{2}:\\d{2}$", description: "HH:MM, Helsinki, 06:00-22:00" },
          text: { type: "string", maxLength: 500, description: "the reminder in Finnish, as it should read in the group" },
        },
        required: ["date", "time", "text"],
      },
      async run(a) {
        const date = String(a.date);
        const time = String(a.time);
        const text = String(a.text).trim();
        if (!text) throw new ToolError("text is empty");
        const [h, m] = time.split(":").map(Number);
        if (h > 23 || m > 59) throw new ToolError(`not a time: ${time}`);
        if (time < EARLIEST || time > LATEST) throw new ToolError(`pick a time between ${EARLIEST} and ${LATEST}; the group gets no reminders at night`);
        const when = fromLocal(date, time);
        if (Number.isNaN(when.getTime()) || localParts(when).date !== date) throw new ToolError(`not a date: ${date}`);
        const now = d.now();
        if (when <= now) throw new ToolError(`${date} ${time} has already passed`);
        if (when.getTime() - now.getTime() > MAX_DAYS * 86_400_000) throw new ToolError(`at most ${MAX_DAYS} days ahead`);
        const at = `${date} ${time}`;
        return change(d.file, (list) => {
          const dup = list.find((r) => r.status === "pending" && r.at === at && r.text === text);
          if (dup) return { ...view(dup), existing: true };
          if (list.filter((r) => r.status === "pending").length >= MAX_PENDING) throw new ToolError(`already ${MAX_PENDING} reminders waiting; cancel one first`);
          const r: GroupReminder = { id: `gr${randomBytes(4).toString("hex")}`, at, text, createdAt: now.toISOString(), status: "pending" };
          list.push(r);
          return view(r);
        });
      },
    },
    {
      name: "group_reminder_list",
      description: "The family-group reminders still waiting, soonest first (all: true adds sent, cancelled and missed ones from the last 30 days). Read-only.",
      input: { properties: { all: { type: "boolean" } } },
      async run(a) {
        const cutoff = d.now().getTime() - 30 * 86_400_000;
        return load(d.file)
          .filter((r) => r.status === "pending" || (a.all === true && atDate(r).getTime() >= cutoff))
          .sort((x, y) => x.at.localeCompare(y.at))
          .map(view);
      },
    },
    {
      name: "group_reminder_cancel",
      description: "Cancel a waiting family-group reminder by id (group_reminder_list shows the ids).",
      input: { properties: { id: { type: "string", maxLength: 40 } }, required: ["id"] },
      async run(a) {
        return change(d.file, (list) => {
          const r = list.find((x) => x.id === a.id);
          if (!r) throw new ToolError(`no reminder ${a.id}; group_reminder_list shows the ids`);
          if (r.status !== "pending") throw new ToolError(`reminder ${r.id} is already ${r.status}`);
          r.status = "cancelled";
          return view(r);
        });
      },
    },
  ];
}

/** Posts the due reminders to the family group; the tick calls it. Returns how many were sent. */
export async function sendGroupReminders(file: string, notifier: Notifier, chat: string, now: Date, log: (s: string) => void = () => {}): Promise<number> {
  if (!existsSync(file)) return 0;
  return change(file, async (list) => {
    let sent = 0;
    for (const r of list.sort((x, y) => x.at.localeCompare(y.at))) {
      if (r.status !== "pending" || atDate(r) > now) continue;
      if (now.getTime() - atDate(r).getTime() > LATE_MS) {
        r.status = "missed";
        log(`group reminder ${r.id} for ${r.at} is over 6 h late: dropped`);
        continue;
      }
      try {
        await notifier.send(chat, `⏰ <b>Muistutus:</b> ${esc(r.text)}`);
      } catch (e) {
        log(`group reminder ${r.id} failed, retrying next tick: ${e instanceof Error ? e.message : e}`);
        continue;
      }
      r.status = "sent";
      r.sentAt = now.toISOString();
      sent++;
    }
    return sent;
  });
}
