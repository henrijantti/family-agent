import { readFileSync } from "node:fs";
import { Config, env, isMock, loadConfig } from "./config.js";
import { FakeCalendar } from "./calendar/fake.js";
import { GoogleCalendar } from "./calendar/google.js";
import { eventId } from "./calendar/sync.js";
import { Ctx, JobName, runDigest, tick } from "./jobs.js";
import { StateStore } from "./lib/state.js";
import { addDays, localIso, localParts, toMinutes } from "./lib/time.js";
import { ConsoleNotifier, TelegramBot } from "./notify/telegram.js";
import { FixtureMyClub, myclubProvider } from "./sources/myclub.js";
import { FixtureMail, GraphMail, deviceSignIn } from "./sources/outlook.js";
import { FixtureWilma, LiveWilma } from "./sources/wilma.js";

const log = (s: string) => console.log(`[${new Date().toISOString()}] ${s}`);
const FIX = new URL("../test/fixtures/", import.meta.url).pathname;

function store() {
  if (env("GITHUB_ACTIONS") && !env("STATE_KEY")) throw new Error("STATE_KEY secret is not set; the agent will not run without encrypted state");
  return new StateStore(env("STATE_FILE") ?? "state/state.json", env("STATE_KEY"));
}

function buildCtx(cfg: Config, state: StateStore, now: Date): Ctx {
  if (isMock()) {
    const cal = new FakeCalendar();
    seedFakeFamily(cal, now);
    process.env.GOOGLE_FAMILY_CALENDAR_ID ??= "family";
    process.env.GOOGLE_SCHOOL_CALENDAR_ID ??= "school";
    process.env.GOOGLE_HOBBIES_CALENDAR_ID ??= "hobbies";
    process.env.TELEGRAM_FAMILY_CHAT_ID ??= "family-group";
    return {
      cfg,
      state: state.data,
      now,
      calendar: cal,
      wilma: new FixtureWilma(`${FIX}wilma.json`),
      myclub: new FixtureMyClub(`${FIX}myclub.json`),
      mail: new FixtureMail(`${FIX}outlook.json`),
      notifier: new ConsoleNotifier(),
      log,
    };
  }
  const has = (...n: string[]) => n.every((x) => !!env(x));
  return {
    cfg,
    state: state.data,
    now,
    calendar: has("GOOGLE_SA_KEY") ? GoogleCalendar.fromEnv() : undefined,
    wilma: cfg.wilma.enabled && has("WILMA_TENANT", "WILMA_USERNAME", "WILMA_PASSWORD") ? new LiveWilma() : undefined,
    myclub: cfg.myclub.enabled && (has("MYCLUB_ICS_URL") || has("MYCLUB_USERNAME", "MYCLUB_PASSWORD")) ? myclubProvider(cfg) : undefined,
    mail: cfg.outlook.enabled && has("OUTLOOK_CLIENT_ID") ? GraphMail.fromEnv(state.data) : undefined,
    notifier: has("TELEGRAM_BOT_TOKEN") ? TelegramBot.fromEnv() : new ConsoleNotifier(),
    log,
  };
}

/** A few hand-made family events so the demo shows dedup and conflicts. */
function seedFakeFamily(cal: FakeCalendar, now: Date) {
  const today = localParts(now).date;
  cal.seed("family", [
    { id: "h1", summary: "Eero: Football tournament", start: { date: addDays(today, 4) }, end: { date: addDays(today, 5) } },
    { id: "h2", summary: "Henri: dentist", start: { dateTime: localIso(today, "17:00") }, end: { dateTime: localIso(today, "17:45") }, location: "Hammaslääkäri" },
  ]);
}

const SECRETS: [string, string][] = [
  ["STATE_KEY", "encrypts the agent's state"],
  ["TELEGRAM_BOT_TOKEN", "Telegram bot"],
  ["TELEGRAM_FAMILY_CHAT_ID", "Telegram family group"],
  ["TELEGRAM_PRIVATE_CHAT_ID", "optional: Henri's private chat for bills"],
  ["GOOGLE_SA_KEY", "Google service account key (JSON)"],
  ["GOOGLE_FAMILY_CALENDAR_ID", "main family calendar (read only)"],
  ["GOOGLE_SCHOOL_CALENDAR_ID", "Family: School (Wilma)"],
  ["GOOGLE_HOBBIES_CALENDAR_ID", "Family: Hobbies (MyClub)"],
  ["WILMA_TENANT", "Wilma address, e.g. https://<city>.inschool.fi"],
  ["WILMA_USERNAME", "Wilma guardian username"],
  ["WILMA_PASSWORD", "Wilma password"],
  ["WILMA_TOTP_SECRET", "optional: Wilma two-step setup key"],
  ["MYCLUB_ICS_URL", "MyClub calendar feed, if the account has one"],
  ["MYCLUB_USERNAME", "MyClub login email (if no feed)"],
  ["MYCLUB_PASSWORD", "MyClub password (if no feed)"],
  ["OUTLOOK_CLIENT_ID", "Entra app (client) id"],
];

/** UTC cron hours/minutes from the tick workflow, to check every slot gets a tick. */
function cronCoverage(cfg: Config): string[] {
  let wf = "";
  try {
    wf = readFileSync(".github/workflows/tick.yml", "utf8");
  } catch {
    return ["tick workflow not found"];
  }
  const m = wf.match(/cron:\s*"([\d,]+) ([\d,]+) \* \* \*"/);
  if (!m) return ["could not read the cron line"];
  const mins = m[1].split(",").map(Number);
  const hours = m[2].split(",").map(Number);
  const problems: string[] = [];
  const slots = [
    ...cfg.wilma.runs.map((r) => ["wilma", r.time]),
    ...cfg.myclub.runs.map((r) => ["myclub", r.time]),
    ...cfg.outlook.runs.map((r) => ["outlook", r.time]),
    ["digest", cfg.digest.weekday_time],
    ["digest (weekend)", cfg.digest.weekend_time],
    ["week-ahead", cfg.digest.week_ahead.time],
  ];
  for (const [name, time] of slots) {
    for (const offset of [2, 3]) {
      const utc = (toMinutes(time) - offset * 60 + 1440) % 1440;
      const covered = hours.some((h) => mins.some((mm) => h * 60 + mm >= utc && h * 60 + mm < utc + 75));
      if (!covered) problems.push(`${name} at ${time} Helsinki has no tick within 75 min (UTC+${offset}); widen the cron in tick.yml`);
    }
  }
  return problems;
}

async function main() {
  const [cmd = "help", ...args] = process.argv.slice(2);
  const cfg = loadConfig();
  const st = store();
  const now = env("FAMILY_AGENT_NOW") ? new Date(env("FAMILY_AGENT_NOW")!) : new Date();

  switch (cmd) {
    case "tick": {
      const forceArg = args.find((a) => a.startsWith("--force="));
      const force = forceArg ? (forceArg.slice(8).split(",").filter(Boolean) as JobName[]) : undefined;
      const ctx = buildCtx(cfg, st, now);
      await tick(ctx, force);
      st.save();
      break;
    }
    case "demo": {
      process.env.FAMILY_AGENT_MOCK = "1";
      const at = new Date(env("FAMILY_AGENT_NOW") ?? "2026-10-21T06:50:00+03:00");
      const ctx = buildCtx(cfg, new StateStore("out/demo-state.json"), at);
      // Two runs: the first learns what exists, the second shows what is new.
      await tick(ctx, ["myclub", "outlook", "wilma"]);
      ctx.state.digestQueue = [];
      ctx.state.wilma.seenMessages = ctx.state.wilma.seenMessages.slice(0, -1);
      ctx.state.wilma.seenNews = ctx.state.wilma.seenNews.slice(0, -1);
      await tick(ctx, ["wilma", "digest"]);
      break;
    }
    case "check": {
      console.log("Secrets and ids (values never printed):");
      for (const [k, why] of SECRETS) console.log(`  ${env(k) ? "✓" : "·"} ${k.padEnd(27)} ${why}`);
      const cov = cronCoverage(cfg);
      console.log(cov.length ? `Schedule problems:\n  ${cov.join("\n  ")}` : "Schedule: every configured time has a tick.");
      break;
    }
    case "calendar-smoke": {
      const cal = GoogleCalendar.fromEnv();
      console.log(`Service account: ${cal.email}`);
      const today = localParts(now).date;
      for (const which of ["GOOGLE_FAMILY_CALENDAR_ID", "GOOGLE_SCHOOL_CALENDAR_ID", "GOOGLE_HOBBIES_CALENDAR_ID"]) {
        const id = env(which);
        if (!id) {
          console.log(`  · ${which} not set`);
          continue;
        }
        const evs = await cal.list(id, { timeMin: new Date(`${today}T00:00:00Z`).toISOString(), timeMax: new Date(`${addDays(today, 7)}T00:00:00Z`).toISOString() });
        console.log(`  ✓ ${which}: can read (${evs.length} events in the next 7 days)`);
      }
      const school = env("GOOGLE_SCHOOL_CALENDAR_ID");
      if (school) {
        const id = eventId("smoke", String(Date.now()));
        await cal.insert(school, { id, summary: "Family agent test event", start: { date: today }, end: { date: addDays(today, 1) } });
        await cal.delete(school, id);
        console.log("  ✓ School calendar: wrote and removed a test event");
      }
      break;
    }
    case "telegram-chats": {
      const chats = await TelegramBot.fromEnv().chats();
      if (!chats.length) console.log("No chats yet. Send any message in the family group (with the bot in it), then run again.");
      for (const c of chats) console.log(`  ${c.type.padEnd(10)} ${String(c.id).padEnd(16)} ${c.title}`);
      break;
    }
    case "telegram-test": {
      await TelegramBot.fromEnv().send(env("TELEGRAM_FAMILY_CHAT_ID")!, "👋 Family agent is connected. Daily digest arrives here.");
      console.log("sent");
      break;
    }
    case "outlook-login": {
      await deviceSignIn(env("OUTLOOK_CLIENT_ID")!, st.data, (s) => console.log(s));
      st.save();
      break;
    }
    case "outlook-test": {
      const mail = GraphMail.fromEnv(st.data);
      const msgs = await mail.listSince(new Date(now.getTime() - 3 * 86400000).toISOString().replace(/\.\d{3}Z$/, "Z"));
      console.log(`Outlook OK: ${msgs.length} messages in the inbox from the last 3 days.`);
      st.save();
      break;
    }
    case "outlook-draft": {
      // npm run agent -- outlook-draft <messageId> <file with reply text>
      const [messageId, file] = args;
      const d = await GraphMail.fromEnv(st.data).createReplyDraft(messageId, readFileSync(file, "utf8"));
      console.log(`Draft saved in Drafts (id ${d.id}). Nothing was sent.`);
      st.save();
      break;
    }
    case "wilma-students": {
      const ctx = buildCtx(cfg, st, now);
      const snap = await ctx.wilma!.fetch(cfg, st.data);
      for (const s of snap.students) console.log(`  ${s.name}  (${s.lessons.length} lessons, ${s.exams.length} upcoming exams)`);
      st.save();
      break;
    }
    case "digest": {
      const ctx = buildCtx(cfg, st, now);
      await runDigest(ctx, args.includes("--week"));
      st.save();
      break;
    }
    default:
      console.log(`Commands:
  tick [--force=myclub,outlook,wilma,digest,week-ahead]   run whatever is due now (Helsinki time)
  demo                     full run on fixtures, prints the digest (no logins)
  check                    which secrets are set, and whether the schedule covers every slot
  calendar-smoke           read the 3 calendars, write + remove a test event
  telegram-chats           list chat ids the bot has seen (to find the family group)
  telegram-test            send a hello to the family group
  outlook-login            device-code sign-in; token stored encrypted in state
  outlook-test             read the last 3 days of inbox
  outlook-draft <id> <file> save a reply draft (never sends)
  wilma-students           list the children on the Wilma login
  digest [--week]          build and send the digest now`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
