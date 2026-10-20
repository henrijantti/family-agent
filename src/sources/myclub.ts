import { readFileSync } from "node:fs";
import { Config, childName, env, requireEnv } from "../config.js";
import type { DesiredEvent } from "../calendar/types.js";
import { parseIcs } from "../lib/ics.js";
import { addDays, fromLocal, localParts } from "../lib/time.js";

// MyClub has no parent-facing API, so the agent reads what Henri sees.
// Two routes, picked by config `myclub.mode`:
//  - ics:   a calendar feed link from Henri's account (secret MYCLUB_ICS_URL).
//  - pages: log in to the member pages as Henri and read them. Read-only:
//           there is no sign-up or payment code here at all.
// UNVERIFIED: myclub.fi was blocked from the build environment, so neither
// route has been tried against the real site. The feasibility check with
// Henri decides which one is used and fills in the page parsers.

export interface MyClubEvent {
  id: string;
  child?: string;
  club?: string;
  title: string;
  start: { date: string } | { dateTime: string };
  end: { date: string } | { dateTime: string };
  location?: string;
  url?: string;
  cancelled?: boolean;
  signup?: { needed: boolean; deadline?: string; answer?: string };
}

export interface MyClubInvoice {
  id: string;
  club: string;
  amount: string;
  dueDate: string;
  reference?: string;
  paid: boolean;
}

export interface MyClubSnapshot {
  fetchedAt: string;
  route: "fixture" | "ics" | "pages";
  events: MyClubEvent[];
  invoices: MyClubInvoice[];
  warnings: string[];
}

export interface MyClubProvider {
  fetch(cfg: Config): Promise<MyClubSnapshot>;
}

export class FixtureMyClub implements MyClubProvider {
  constructor(private path: string) {}
  async fetch(cfg: Config) {
    const s = JSON.parse(readFileSync(this.path, "utf8")) as MyClubSnapshot;
    s.events = s.events.map((e) => ({ ...e, child: e.child ? childName(cfg, e.child) : undefined }));
    return s;
  }
}

/**
 * MYCLUB_ICS_URL holds one feed, or several as lines "Child|https://...".
 */
export class IcsMyClub implements MyClubProvider {
  async fetch(cfg: Config): Promise<MyClubSnapshot> {
    const feeds = parseFeeds(requireEnv("MYCLUB_ICS_URL"));
    const events: MyClubEvent[] = [];
    const warnings: string[] = [];
    for (const f of feeds) {
      const res = await fetch(f.url.replace(/^webcal:/, "https:"));
      if (!res.ok) throw new Error(`MyClub feed ${res.status}`);
      for (const e of parseIcs(await res.text())) {
        if (e.recurring) warnings.push(`Recurring MyClub event "${e.summary}" not expanded`);
        events.push({
          id: e.uid,
          child: f.child ? childName(cfg, f.child) : undefined,
          title: e.summary.replace(/^(PERUTTU|CANCELLED|PERUTTU:)\s*:?\s*/i, ""),
          start: e.start,
          end: e.end,
          location: e.location,
          url: e.url,
          cancelled: e.cancelled || /^(peruttu|cancelled)/i.test(e.summary),
        });
      }
    }
    warnings.push("Calendar feed has no sign-ups or invoices; those need the page reader");
    return { fetchedAt: new Date().toISOString(), route: "ics", events, invoices: [], warnings };
  }
}

export function parseFeeds(raw: string): { child?: string; url: string }[] {
  return raw
    .split(/[\n;]+/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => (l.includes("|") ? { child: l.split("|")[0].trim(), url: l.split("|")[1].trim() } : { url: l }));
}

/**
 * Member-page reader. Logs in with the form it finds on the login page, then
 * looks for a calendar feed link on the member pages and uses it. The event,
 * sign-up and invoice page parsers are placeholders until the real pages
 * have been seen (feasibility check).
 */
export class PagesMyClub implements MyClubProvider {
  private cookies = new Map<string, string>();

  private async get(url: string, init: RequestInit = {}): Promise<{ res: Response; url: string }> {
    const res = await fetch(url, {
      ...init,
      redirect: "manual",
      headers: { ...(init.headers ?? {}), cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ") },
    });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [kv] = c.split(";");
      const i = kv.indexOf("=");
      this.cookies.set(kv.slice(0, i).trim(), kv.slice(i + 1));
    }
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc) {
      const next = new URL(loc, url);
      if (!next.hostname.endsWith("myclub.fi")) throw new Error(`MyClub redirected off-site to ${next.hostname}`);
      return this.get(next.toString());
    }
    return { res, url };
  }

  async fetch(cfg: Config): Promise<MyClubSnapshot> {
    const { load } = await import("cheerio");
    const loginUrl = env("MYCLUB_LOGIN_URL") ?? `${cfg.myclub.base_url}/login`;
    const page = await this.get(loginUrl);
    const $ = load(await page.res.text());
    const form = $("form").filter((_, f) => $(f).find("input[type=password]").length > 0).first();
    if (!form.length) throw new Error("MyClub login form not found (login may use an emailed code: see the feasibility check)");
    const fields = new URLSearchParams();
    form.find("input").each((_, i) => {
      const name = $(i).attr("name");
      if (!name) return;
      const type = ($(i).attr("type") ?? "text").toLowerCase();
      if (type === "password") fields.set(name, requireEnv("MYCLUB_PASSWORD"));
      else if (type === "email" || /user|email|login/i.test(name)) fields.set(name, requireEnv("MYCLUB_USERNAME"));
      else fields.set(name, $(i).attr("value") ?? "");
    });
    const action = new URL(form.attr("action") ?? loginUrl, page.url).toString();
    const after = await this.get(action, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: fields,
    });
    const home = await after.res.text();
    if (/type=["']?password/i.test(home)) throw new Error("MyClub login refused (check MYCLUB_USERNAME / MYCLUB_PASSWORD)");

    const feed = load(home)('a[href$=".ics"], a[href^="webcal:"], a[href*="ical"]').first().attr("href");
    if (feed) {
      process.env.MYCLUB_ICS_URL = new URL(feed, after.url).toString();
      const s = await new IcsMyClub().fetch(cfg);
      return { ...s, route: "pages", warnings: [...s.warnings, "Found a calendar feed on the member pages; consider saving it as MYCLUB_ICS_URL"] };
    }
    return {
      fetchedAt: new Date().toISOString(),
      route: "pages",
      events: [],
      invoices: [],
      warnings: ["Logged in to MyClub, but the event/sign-up/invoice page parsers are not written yet (needs a look at the real pages)"],
    };
  }
}

export function myclubProvider(cfg: Config): MyClubProvider {
  const mode = cfg.myclub.mode === "auto" ? (env("MYCLUB_ICS_URL") ? "ics" : "pages") : cfg.myclub.mode;
  return mode === "ics" ? new IcsMyClub() : new PagesMyClub();
}

// ---------- pure logic ----------

export function myclubEvents(snap: MyClubSnapshot, cfg: Config, now = new Date()): DesiredEvent[] {
  const today = localParts(now).date;
  const horizon = addDays(today, cfg.myclub.horizon_weeks * 7);
  return snap.events
    .filter((e) => {
      const d = "date" in e.start ? e.start.date : localParts(new Date(e.start.dateTime)).date;
      return d >= today && d <= horizon;
    })
    .map((e) => {
      const deadline = e.signup?.needed && e.signup.deadline && !e.signup.answer;
      return {
        source: "myclub" as const,
        sourceId: e.id,
        title: `${e.cancelled ? "CANCELLED: " : ""}${e.child ? `${e.child}: ` : ""}${e.title}`,
        start: withTz(e.start, cfg),
        end: withTz(e.end, cfg),
        location: e.location,
        url: e.url,
        description: e.signup?.needed ? `Sign-up needed${e.signup.deadline ? ` by ${e.signup.deadline}` : ""}. Answer in the MyClub app.` : undefined,
        reminderMinutes: deadline ? minutesBefore(e.start, e.signup!.deadline!) : undefined,
      };
    });
}

/** Popup 2 days before the sign-up deadline (18:00), expressed relative to the event start. */
function minutesBefore(start: MyClubEvent["start"], deadline: string): number {
  const startMs = "date" in start ? fromLocal(start.date).getTime() : Date.parse(start.dateTime);
  const remindAt = fromLocal(addDays(deadline, -2), "18:00").getTime();
  return Math.max(0, Math.min(40320, Math.round((startMs - remindAt) / 60000)));
}

function withTz(t: MyClubEvent["start"], cfg: Config) {
  return "date" in t ? t : { dateTime: t.dateTime, timeZone: cfg.timezone };
}

/** Sign-ups closing within `days` that have no answer yet. */
export function openSignups(snap: MyClubSnapshot, today: string, days = 3) {
  return snap.events.filter(
    (e) => e.signup?.needed && !e.signup.answer && e.signup.deadline && e.signup.deadline >= today && e.signup.deadline <= addDays(today, days),
  );
}

export function feesDue(snap: MyClubSnapshot, today: string, days = 7) {
  return snap.invoices.filter((i) => !i.paid && i.dueDate <= addDays(today, days));
}
