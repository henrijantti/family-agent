import { readFileSync } from "node:fs";
import { Config, env, isMock, loadConfig } from "./config.js";
import { FakeCalendar } from "./calendar/fake.js";
import { GoogleCalendar } from "./calendar/google.js";
import { eventId } from "./calendar/sync.js";
import { Ctx, JobName, runDigest, tick, wilmaFetchDue } from "./jobs.js";
import { StateStore } from "./lib/state.js";
import { addDays, fromLocal, localIso, localParts, toMinutes } from "./lib/time.js";
import { ConsoleNotifier, TelegramBot } from "./notify/telegram.js";
import { FixtureMyClub, IcsMyClub, myclubProvider } from "./sources/myclub.js";
import { MyClubInvites, MyClubWriter } from "./sources/myclub-signup.js";
import { FixtureMail, GraphMail, deviceSignIn } from "./sources/outlook.js";
import { FixtureWilma, LiveWilma, SnapshotWilma } from "./sources/wilma.js";
import { encrypt } from "./lib/state.js";
import { triage, triageReport } from "./outlook-triage.js";
import { mkdirSync, writeFileSync } from "node:fs";

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
    wilma: !cfg.wilma.enabled
      ? undefined
      : env("WILMA_MODE") === "snapshot"
        ? new SnapshotWilma(env("WILMA_SNAPSHOT_FILE") ?? "state/wilma-snapshot.json", env("STATE_KEY"), now)
        : has("WILMA_TENANT", "WILMA_USERNAME", "WILMA_PASSWORD")
          ? new LiveWilma()
          : undefined,
    myclub: cfg.myclub.enabled && (has("MYCLUB_ICS_URL") || has("MYCLUB_USERNAME", "MYCLUB_PASSWORD")) ? myclubProvider(cfg) : undefined,
    attendanceWriter: cfg.attendance?.live && has("MYCLUB_USERNAME", "MYCLUB_PASSWORD") ? new MyClubWriter() : undefined,
    myclubInvites: !cfg.myclub.enabled
      ? undefined
      : cfg.attendance?.clubs?.length && has("MYCLUB_USERNAME", "MYCLUB_PASSWORD")
        ? new MyClubInvites(cfg.attendance.clubs)
        : has("MYCLUB_POLL_ICS_URL")
          ? new IcsMyClub("MYCLUB_POLL_ICS_URL")
          : undefined,
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
  ["MYCLUB_ICS_URL", "MyClub feeds, 'Osallistun' (Name|link per line): calendar"],
  ["MYCLUB_POLL_ICS_URL", "MyClub feeds, 'Ei vastausta' (Name|link per line): weekly poll"],
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
    ...(cfg.attendance?.enabled ? [["attendance-poll", cfg.attendance.poll.time], ["attendance-apply", cfg.attendance.apply.time]] : []),
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
      const snapshotMode = env("WILMA_MODE") === "snapshot";
      for (const [k, why] of SECRETS) {
        if (snapshotMode && k.startsWith("WILMA_")) continue; // only the laptop runner gets these
        console.log(`  ${env(k) ? "✓" : "·"} ${k.padEnd(27)} ${why}`);
      }
      if (snapshotMode) {
        try {
          const snap = await new SnapshotWilma(env("WILMA_SNAPSHOT_FILE") ?? "state/wilma-snapshot.json", env("STATE_KEY"), now, 24 * 14).fetch(cfg);
          console.log(`  ✓ Wilma snapshot from the laptop: ${snap.students.length} children, fetched ${snap.fetchedAt}`);
        } catch (e) {
          console.log(`  · Wilma snapshot: ${(e as Error).message}`);
        }
      }
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
        try {
          const evs = await cal.list(id, { timeMin: new Date(`${today}T00:00:00Z`).toISOString(), timeMax: new Date(`${addDays(today, 7)}T00:00:00Z`).toISOString() });
          console.log(`  ✓ ${which}: can read (${evs.length} events in the next 7 days)`);
        } catch (e) {
          const status = (e as { status?: number }).status;
          const hint = status === 404 ? "not found: check the id, and that the calendar is shared with the service account" : status === 403 ? "no access: share the calendar with the service account" : String(e);
          console.log(`  ✗ ${which}: ${hint}`);
          process.exitCode = 1;
        }
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
    case "outlook-bills-rescan": {
      // Re-reads the lookback window so bills recorded earlier get fields a newer parser finds.
      const { scanInvoices } = await import("./sources/outlook.js");
      const mail = GraphMail.fromEnv(st.data);
      st.data.outlook.lastScan = undefined;
      const r = await scanInvoices(mail, st.data, cfg.outlook.scan_lookback_days, now);
      console.log(`rescan: ${r.newBills.length} new bills`);
      for (const b of st.data.outlook.bills) console.log(`  ${b.biller}: ${b.amount ?? "(no amount)"} due ${b.dueDate ?? "-"}`);
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
    case "outlook-triage": {
      // npm run agent -- outlook-triage [days=180] [--dry]
      const days = Number(args.find((a) => /^\d+$/.test(a)) ?? 180);
      const apply = !args.includes("--dry");
      const since = new Date(now.getTime() - days * 86400000).toISOString().replace(/\.\d{3}Z$/, "Z");
      const r = await triage(GraphMail.fromEnv(st.data), since, { max: 3000, apply, now, skipDomains: cfg.outlook.wilma_folder?.senders ?? [], self: ["henri.jantti@outlook.com"], state: st.data });
      console.log(triageReport(r, now));
      console.log(apply ? `\nLabelled in Outlook (${r.skipped} already had the label). Nothing was moved, deleted or sent.` : "\nDry run: nothing was changed.");
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
    case "wilma-fetch": {
      // Runs on the home runner: log in to Wilma from the home connection and
      // save an encrypted snapshot for the GitHub-hosted tick to read.
      const session = new StateStore(env("WILMA_SESSION_FILE") ?? "state/wilma-session.json", env("STATE_KEY"));
      const key = args.includes("--force") ? `forced ${now.toISOString()}` : wilmaFetchDue(cfg, session.data.lastRun, now);
      if (!key) {
        console.log(`no Wilma fetch due at ${localParts(now).date} ${localParts(now).time} Helsinki`);
        break;
      }
      const snap = await new LiveWilma().fetch(cfg, session.data);
      // Remember what was fetched in full, so the next fetch only opens new items.
      const w = session.data.wilma;
      for (const st of snap.students) {
        w.seenMessages = [...new Set([...w.seenMessages, ...st.messages.map((m) => m.id)])].slice(-500);
        w.seenNews = [...new Set([...w.seenNews, ...st.news.map((n) => n.id)])].slice(-500);
      }
      const slot = key.startsWith("forced") ? undefined : key.split(" ")[1];
      if (slot) session.data.lastRun[`wilma-fetch@${slot}`] = key;
      const out = env("WILMA_SNAPSHOT_FILE") ?? "state/wilma-snapshot.json";
      mkdirSync("state", { recursive: true });
      const json = JSON.stringify(snap);
      writeFileSync(out, env("STATE_KEY") ? encrypt(json, env("STATE_KEY")!) : json);
      session.save();
      console.log(`Wilma fetched: ${snap.students.length} children`);
      break;
    }
    case "myclub-check": {
      // Reads the MyClub feeds and prints a summary; writes nothing.
      if (!env("MYCLUB_ICS_URL") && !env("MYCLUB_USERNAME")) throw new Error("MYCLUB_ICS_URL is not set: add the MyClub calendar links as a repository secret");
      const snap = await myclubProvider(cfg).fetch(cfg);
      console.log(`MyClub (${snap.route}): ${snap.events.length} events`);
      const today = localParts(now).date;
      const when = (e: (typeof snap.events)[number]) => ("date" in e.start ? e.start.date : (() => { const lp = localParts(new Date(e.start.dateTime)); return `${lp.date} ${lp.time}`; })());
      const byChild = new Map<string, typeof snap.events>();
      for (const e of snap.events) byChild.set(e.child ?? "?", [...(byChild.get(e.child ?? "?") ?? []), e]);
      for (const [child, evs] of byChild) {
        const next = evs.filter((e) => when(e).slice(0, 10) >= today).sort((a, b) => when(a).localeCompare(when(b)));
        console.log(`  ${child}: ${evs.length} events, ${next.length} upcoming`);
        for (const e of next.slice(0, 5)) console.log(`    ${when(e)} ${e.title}${e.cancelled ? " (cancelled)" : ""}`);
      }
      for (const w of snap.warnings.slice(0, 5)) console.log(`  note: ${w}`);
      if (snap.route === "ics") console.log("  note: calendar feeds carry events only, not sign-up deadlines or fees");
      break;
    }
    case "myclub-signup-test": {
      // Safe end-to-end check: re-confirms "attending" on each boy's next event
      // that is already marked attending in MyClub, so nothing changes.
      const snap = await new IcsMyClub("MYCLUB_ICS_URL").fetch(cfg);
      const writer = new MyClubWriter();
      for (const child of cfg.attendance?.children ?? []) {
        const next = snap.events
          .filter((e) => e.child === child && e.url && !e.cancelled && Date.parse("dateTime" in e.start ? e.start.dateTime : e.start.date) > Date.now())
          .sort((a, b) => JSON.stringify(a.start).localeCompare(JSON.stringify(b.start)))[0];
        if (!next) {
          console.log(`${child}: no upcoming signed-up event to test with`);
          continue;
        }
        const { optionLabel } = await import("./attendance.js");
        try {
          const r = await writer.set({ eventId: next.id, url: next.url, label: optionLabel(next), date: "" }, child, true);
          console.log(`${child}: ${optionLabel(next)}: ${r} (it was already signed up, so nothing changed)`);
        } catch (e) {
          console.log(`${child}: ${optionLabel(next)}: FAILED ${(e as Error).message}`);
        }
      }
      break;
    }
    case "myclub-open": {
      // Read-only: how the logged-in MyClub pages expose one event and the child's answer.
      const { load } = await import("cheerio");
      const writer = new MyClubWriter();
      const host = "ppj.myclub.fi";
      const evs = await writer.listEvents(host, "Oskar");
      const keys = new Set(evs.flatMap((e) => Object.keys(e)));
      console.log(`list keys (all events): ${[...keys].join(", ")}`);
      const lit = evs.filter((e) => /Litmanen|omatoimivuoro/.test(String(e.name))).slice(0, 3);
      for (const e of lit) console.log(`list item: ${JSON.stringify(e).slice(0, 400)}`);
      const id = lit[0]?.id ?? evs[0].id;
      for (const path of [`/flow/events/${id}`, `/flow/events/11776019`, `/flow/events`]) {
        const r = await writer.peek(host, path);
        const $ = load(r.body);
        $("script, style, nav, header").remove();
        const text = $("body").text().replace(/\s+/g, " ").trim();
        const i = text.lastIndexOf("Kirjaudu ulos");
        console.log(`\n== GET ${path}: ${r.status}`);
        console.log(`  text: ${text.slice(i + 13, i + 13 + 2500)}`);
        const marks = new Set<string>();
        $("[class*=particip], [class*=indicat], [class*=attend], [class*=status], [data-indication], [data-participation], form, button").each((_, el) => {
          const at = Object.entries(el.attribs).map(([k, v]) => `${k}=${v.slice(0, 60)}`).join(" ");
          marks.add(`<${el.tagName} ${at}> ${$(el).text().replace(/\s+/g, " ").trim().slice(0, 50)}`);
        });
        console.log(`  marks:\n    ${[...marks].slice(0, 40).join("\n    ")}`);
      }
      break;
    }
    case "myclub-discover": {
      const { discoverMyClub } = await import("./myclub-discover.js");
      await discoverMyClub(cfg);
      break;
    }
    case "attendance-preview":
    case "attendance-poll-next": {
      // preview: what the practice polls would ask, posts nothing. poll-next: sends
      // the polls now for next Monday-Sunday (or the date given).
      const { weekEvents, optionLabel, runAttendancePoll } = await import("./attendance.js");
      const today = localParts(now).date;
      const nextMon = addDays(today, ((8 - new Date(`${today}T12:00:00Z`).getUTCDay()) % 7) || 7);
      const dateArg = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
      const club = args.find((a) => !/^\d{4}-/.test(a));
      const start = dateArg ?? (cmd === "attendance-poll-next" ? nextMon : undefined);
      const ctx = buildCtx(cfg, st, now);
      if (cmd === "attendance-poll-next") {
        await runAttendancePoll(ctx, start, club);
        st.save();
        break;
      }
      const snap = await (ctx.myclubInvites ?? myclubProvider(cfg)).fetch(cfg);
      for (const w of snap.warnings.slice(0, 5)) console.log(`note: ${w}`);
      for (const child of cfg.attendance?.children ?? []) {
        const evs = weekEvents(snap, cfg, child, now, start);
        const all = snap.events.filter((e) => e.child === child && !e.cancelled);
        console.log(`${child}: ${all.length} unanswered found, ${evs.length} in the 7 days from ${start ?? "tomorrow"}`);
        for (const e of all) console.log(`  ${evs.includes(e) ? "[ ]" : "   "} ${e.club ? `${e.club}: ` : ""}${optionLabel(e)}`);
      }
      break;
    }
    case "wilma-check": {
      // Diagnoses a refused Wilma login without sending credentials.
      const { normaliseTenant } = await import("./sources/wilma.js");
      const base = normaliseTenant(env("WILMA_TENANT") ?? "");
      const u = new URL(base);
      console.log(`Tenant host ends with: …${u.hostname.slice(-14)}  path: "${u.pathname}"`);
      if (u.pathname !== "/") console.log("  ! The address has a path after the host; it should be just https://<city>.inschool.fi");
      const ip = await fetch("https://api.ipify.org").then((r) => r.text()).catch(() => "?");
      console.log(`Runner public IP: ${ip}`);
      for (const path of ["/", "/token"]) {
        const r = await fetch(`${u.origin}${path}`, { redirect: "manual", headers: { "user-agent": "Mozilla/5.0" } });
        const body = (await r.text()).replace(/\s+/g, " ").slice(0, 300);
        console.log(`GET ${path}: ${r.status} server=${r.headers.get("server")} cf-ray=${r.headers.get("cf-ray") ?? "-"}`);
        console.log(`  body: ${body}`);
      }
      break;
    }
    case "week-preview": {
      // Prints next week's (Mon-Sun) summary from real data. Sends nothing, saves no state.
      const today = localParts(now).date;
      const sunday = addDays(today, (7 - new Date(`${today}T12:00:00Z`).getUTCDay()) % 7);
      const ctx = buildCtx(cfg, st, fromLocal(sunday, "19:00"));
      ctx.notifier = undefined;
      delete process.env.TELEGRAM_PRIVATE_CHAT_ID;
      delete process.env.TELEGRAM_FAMILY_CHAT_ID;
      console.log(`----- preview -----\n${await runDigest(ctx, true)}\n----- end -----`);
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
  outlook-triage [days] [--dry]  label invoices, unsubscribe candidates, important mail
  outlook-draft <id> <file> save a reply draft (never sends)
  wilma-students           list the children on the Wilma login
  wilma-fetch [--force]    (home runner) fetch Wilma if a slot is near, save the snapshot
  digest [--week]          build and send the digest now`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
