import { AttendanceWriter, DryRunWriter, optionLabel, PollOption, weekEvents } from "../attendance.js";
import { Config } from "../config.js";
import { Ctx, runMyClub, runOutlook } from "../jobs.js";
import { withLock } from "../lib/lock.js";
import { StateData, StateStore } from "../lib/state.js";
import { localParts } from "../lib/time.js";
import { Notifier } from "../notify/telegram.js";
import { MyClubSnapshot } from "../sources/myclub.js";
import { billsToRemind } from "../sources/outlook.js";
import { stripHtml } from "./family-tools.js";
import { Tool, ToolError } from "./mcp.js";

// The scheduled jobs as tools, so the OpenClaw agent runs them (Henri chose
// "AI does the jobs", 2026-10-23). The work itself is the same tested code the
// tick runs. Differences: nothing is posted to Telegram here (messages come
// back to the agent, which posts them), and every call takes the state lock.
// A job belongs to either the agent or the tick: list it in config
// `agent_jobs` when the agent takes it over, so the tick skips it.

export interface JobsDeps {
  cfg: Config;
  /** Opens the state file; called inside the lock. */
  openState(): StateStore;
  statePath: string;
  /** A job context over the given state, with sources and calendar. */
  makeCtx(state: StateData, notifier: Notifier): Ctx;
  now(): Date;
  /** The family-group agent's copy: no bill scan, and its digest doesn't use up bill reminders it never showed. */
  group?: boolean;
}

/** Collects what a job would have posted, as plain text for the agent. */
class Collect implements Notifier {
  messages: string[] = [];
  async send(_chat: string, html: string) {
    this.messages.push(stripHtml(html));
  }
}

function owned(d: JobsDeps, job: string) {
  if (!d.cfg.agent_jobs?.includes(job)) {
    throw new ToolError(`${job} still runs in the 15-minute tick; add it to agent_jobs in config.yaml first so it doesn't run twice`);
  }
}

async function withState<T>(d: JobsDeps, fn: (st: StateStore, ctx: Ctx, out: Collect) => Promise<T>): Promise<T> {
  return withLock(d.statePath, async () => {
    const st = d.openState();
    const out = new Collect();
    const ctx = d.makeCtx(st.data, out);
    const r = await fn(st, ctx, out);
    st.save();
    return r;
  });
}

const key = (child: string, eventId: string) => `${child}|${eventId}`;

export function jobsTools(d: JobsDeps): Tool[] {
  const tools: Tool[] = [
    {
      name: "sync_myclub",
      description:
        "Read MyClub and update the Hobbies calendar (the tick's MyClub job). Returns what changed and any alert lines to post.",
      input: { properties: {} },
      async run() {
        owned(d, "myclub");
        return withState(d, async (st, ctx, out) => {
          const before = st.data.changes.length;
          await runMyClub(ctx);
          return { health: st.data.health.MyClub, changes: st.data.changes.slice(before), alerts: out.messages };
        });
      },
    },
    {
      name: "scan_bills",
      description: "Scan Henri's Outlook for new bills and flag them (the tick's Outlook job). Returns the bills found this run.",
      input: { properties: {} },
      async run() {
        owned(d, "outlook");
        return withState(d, async (st, ctx) => {
          const known = new Set(st.data.outlook.bills.map((b) => b.messageId));
          await runOutlook(ctx);
          const fresh = st.data.outlook.bills.filter((b) => !known.has(b.messageId));
          return {
            health: st.data.health.Outlook,
            newBills: fresh.map((b) => ({ biller: b.biller, amount: b.amount, dueDate: b.dueDate, reference: b.reference, newBiller: b.newBiller })),
          };
        });
      },
    },
    {
      name: "digest_mark_sent",
      description:
        "Call right after posting the morning digest (daily) or the week summary (week) to the family group, so tomorrow's digest doesn't repeat today's bill reminders and school news.",
      input: { properties: { kind: { type: "string", enum: ["daily", "week"] } }, required: ["kind"] },
      async run(a) {
        owned(d, a.kind === "week" ? "week-ahead" : "digest");
        return withState(d, async (st) => {
          const now = d.now();
          const today = localParts(now).date;
          const due = d.cfg.outlook.enabled && !d.group ? billsToRemind(st.data, today, d.cfg.outlook.remind_days_before) : [];
          for (const b of st.data.outlook.bills) if (due.some((x) => x.messageId === b.messageId)) (b.remindedOn ??= []).push(today);
          // Both reports show schoolNews from digest_data, so both use it up (as the script does).
          st.data.digestQueue = [];
          st.data.lastDigestAt = now.toISOString();
          return { marked: a.kind, billsReminded: due.length };
        });
      },
    },
    {
      name: "attendance_week",
      description:
        "Start the weekly practice question: next week's unanswered MyClub events per child (from the logged-in MyClub pages). Post one message per child with a button per event. Use callback value `att|<child>|<eventId>|1` for going and `|0` for not going.",
      input: { properties: {} },
      async run() {
        owned(d, "attendance-poll");
        return withState(d, async (st, ctx) => {
          const cfg = d.cfg.attendance;
          if (!cfg?.enabled) throw new ToolError("attendance is switched off in config");
          const snap = ctx.myclubInvites ? await ctx.myclubInvites.fetch(d.cfg) : (st.data.myclub.lastSnapshot as MyClubSnapshot | undefined);
          if (!snap) throw new ToolError("no MyClub data yet");
          const options: Record<string, PollOption[]> = {};
          for (const child of cfg.children) {
            options[child] = weekEvents(snap, d.cfg, child, d.now()).map((e) => ({
              eventId: e.id,
              url: e.url,
              label: optionLabel(e),
              date: "date" in e.start ? e.start.date : localParts(new Date(e.start.dateTime)).date,
            }));
          }
          st.data.myclub.agentPoll = { postedAt: d.now().toISOString(), options, votes: {}, status: "open" };
          return Object.fromEntries(Object.entries(options).map(([c, o]) => [c, o.map((x) => ({ eventId: x.eventId, label: x.label }))]));
        });
      },
    },
    {
      name: "attendance_record",
      description:
        "Store one answer from a button press (att|child|eventId|1 or 0) and sign the child up (or out) in MyClub at once, then refresh the Hobbies calendar. The last press for an event wins.",
      input: {
        properties: {
          child: { type: "string", maxLength: 40 },
          eventId: { type: "string", maxLength: 100 },
          going: { type: "boolean" },
        },
        required: ["child", "eventId", "going"],
      },
      async run(a) {
        owned(d, "attendance-poll");
        return withState(d, async (st, ctx) => {
          const poll = st.data.myclub.agentPoll;
          if (!poll || poll.status !== "open") throw new ToolError("no open practice question; this week's answers were already applied");
          const offered = poll.options[a.child as string]?.find((o) => o.eventId === a.eventId);
          if (!offered) throw new ToolError(`event ${a.eventId} was not offered for ${a.child}`);
          const going = a.going as boolean;
          poll.votes[key(a.child as string, a.eventId as string)] = going;
          // Sign up at once (Henri, 2026-10-25), so the calendar, week summary and dashboard
          // show the answer tonight instead of after Monday's apply. The apply repeats it harmlessly.
          const writer: AttendanceWriter = ctx.attendanceWriter ?? new DryRunWriter();
          let myclub: string;
          try {
            myclub = await writer.set(offered, a.child as string, going);
          } catch (e) {
            myclub = `failed: ${(e as Error).message}`;
          }
          const declined = new Set(st.data.myclub.declined ?? []);
          if (going) declined.delete(offered.eventId);
          else declined.add(offered.eventId);
          st.data.myclub.declined = [...declined].slice(-200);
          if (writer.live && !myclub.startsWith("failed")) await runMyClub(ctx);
          return { child: a.child, event: offered.label, going, myclub };
        });
      },
    },
    {
      name: "attendance_apply",
      description:
        "Monday morning: sign the children up in MyClub for the events answered 'going' and decline those answered 'not going'. Events nobody answered are left as they are. Returns the result lines to post.",
      input: { properties: {} },
      async run() {
        owned(d, "attendance-apply");
        return withState(d, async (st, ctx) => {
          const poll = st.data.myclub.agentPoll;
          if (!poll || poll.status !== "open") return { applied: false, reason: "no open practice question" };
          const writer: AttendanceWriter = ctx.attendanceWriter ?? new DryRunWriter();
          const declined = new Set(st.data.myclub.declined ?? []);
          const results: Record<string, string[]> = {};
          for (const [child, opts] of Object.entries(poll.options)) {
            for (const o of opts) {
              const vote = poll.votes[key(child, o.eventId)];
              if (vote === undefined) continue;
              let r: string;
              try {
                r = await writer.set(o, child, vote);
              } catch (e) {
                r = `failed: ${(e as Error).message}`;
              }
              if (vote) declined.delete(o.eventId);
              else declined.add(o.eventId);
              (results[child] ??= []).push(`${vote ? "✅" : "➖"} ${o.label} (${r})`);
            }
          }
          st.data.myclub.declined = [...declined].slice(-200);
          poll.status = "applied";
          return { applied: true, live: writer.live, results, unanswered: Object.keys(poll.options).filter((c) => !results[c]) };
        });
      },
    },
  ];
  return d.group ? tools.filter((t) => t.name !== "scan_bills") : tools;
}
