import { requireEnv, type Config } from "../config.js";
import type { AttendanceWriter, PollOption } from "../attendance.js";
import { addDays, fromLocal, localParts } from "../lib/time.js";
import type { MyClubEvent, MyClubProvider, MyClubSnapshot } from "./myclub.js";

// Signs a child in or out of one MyClub event, the way MyClub's own web page
// does: log in at id.myclub.fi, pick the child's member account in that club
// (select_account), then PATCH /flow/events/<id>.json with indication 1 (in)
// or 3 (out). Nothing else in MyClub is ever written.

const IN = 1;
const OUT = 3;

export class MyClubWriter implements AttendanceWriter {
  readonly live = true;
  private cookies = new Map<string, Map<string, string>>();
  private loggedIn = false;
  private account = new Map<string, string>(); // club host -> child currently selected

  private cookieHeader(host: string) {
    const out: string[] = [];
    for (const [dom, m] of this.cookies) if (host === dom || host.endsWith(`.${dom}`)) for (const [k, v] of m) out.push(`${k}=${v}`);
    return out.join("; ");
  }

  private async req(url: string, init: RequestInit = {}, hops = 0): Promise<{ status: number; url: string; body: string }> {
    const u = new URL(url);
    if (u.protocol !== "https:" || !u.hostname.endsWith(".myclub.fi")) throw new Error(`refusing non-MyClub URL ${u.hostname}`);
    const res = await fetch(url, { ...init, redirect: "manual", headers: { "user-agent": "Mozilla/5.0 family-agent", ...(init.headers ?? {}), cookie: this.cookieHeader(u.hostname) } });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const parts = c.split(";").map((p) => p.trim());
      const i = parts[0].indexOf("=");
      const dom = parts.find((p) => /^domain=/i.test(p))?.slice(7).replace(/^\./, "") ?? u.hostname;
      if (!this.cookies.has(dom)) this.cookies.set(dom, new Map());
      this.cookies.get(dom)!.set(parts[0].slice(0, i), parts[0].slice(i + 1));
    }
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc && hops < 10) return this.req(new URL(loc, url).toString(), {}, hops + 1);
    return { status: res.status, url, body: await res.text() };
  }

  private async login() {
    if (this.loggedIn) return;
    const { load } = await import("cheerio");
    const page = await this.req("https://id.myclub.fi/flow/login");
    const $ = load(page.body);
    const token = $('input[name="authenticity_token"]').attr("value");
    if (!token) throw new Error("MyClub login page changed (no authenticity_token)");
    const body = new URLSearchParams({
      authenticity_token: token,
      "user_session[email]": requireEnv("MYCLUB_USERNAME"),
      "user_session[password]": requireEnv("MYCLUB_PASSWORD"),
    });
    const after = await this.req("https://id.myclub.fi/flow/user_session", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
    if (/user_session\[password\]/.test(after.body)) throw new Error("MyClub login refused (check MYCLUB_USERNAME / MYCLUB_PASSWORD)");
    this.loggedIn = true;
  }

  /** Switches the club's active member account to the child; returns that page's CSRF token. */
  private async selectChild(host: string, child: string): Promise<string> {
    const { load } = await import("cheerio");
    let page = await this.req(`https://${host}/flow/events`);
    let $ = load(page.body);
    if (this.account.get(host) !== child) {
      const link = $(`a[href*="${host}/flow/select_account"], a[href^="/flow/select_account"]`)
        .filter((_, a) => $(a).text().includes(child))
        .first()
        .attr("href");
      if (!link) throw new Error(`no ${child} member account in ${host.split(".")[0]}`);
      page = await this.req(new URL(link, `https://${host}/`).toString());
      $ = load(page.body);
      this.account.set(host, child);
    }
    const csrf = $('meta[name="csrf-token"]').attr("content");
    if (!csrf) throw new Error("MyClub page changed (no CSRF token)");
    return csrf;
  }

  /** Read-only: the club's events list for the child, as the page's data-events JSON. */
  async listEvents(host: string, child: string, query = ""): Promise<Record<string, unknown>[]> {
    const { load } = await import("cheerio");
    await this.login();
    await this.selectChild(host, child);
    const page = await this.req(`https://${host}/flow/events${query}`);
    const raw = load(page.body)("#events").attr("data-events");
    return raw ? (JSON.parse(raw) as Record<string, unknown>[]) : [];
  }

  /** Read-only GET on a club page as the selected child. */
  async peek(host: string, path: string, xhr = false) {
    return this.req(`https://${host}${path}`, xhr ? { headers: { accept: "application/json, text/javascript, text/html, */*; q=0.01", "x-requested-with": "XMLHttpRequest" } } : {});
  }

  async set(option: PollOption, child: string, attend: boolean): Promise<string> {
    const m = option.url?.match(/^https:\/\/([a-z0-9-]+\.myclub\.fi)\/flow\/events\/(\d+)/);
    if (!m) throw new Error("no MyClub event link in the feed");
    const [, host, id] = m;
    await this.login();
    const csrf = await this.selectChild(host, child);
    const want = attend ? IN : OUT;
    const res = await this.req(`https://${host}/flow/events/${id}.json`, {
      method: "PATCH",
      headers: {
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        accept: "application/json, text/javascript, */*; q=0.01",
        "x-requested-with": "XMLHttpRequest",
        "x-csrf-token": csrf,
      },
      body: new URLSearchParams({ "participation[indication_id]": String(want) }),
    });
    if (res.status >= 400) throw new Error(`MyClub said ${res.status}${res.status === 422 ? " (sign-up closed or needs the form in MyClub)" : ""}`);
    let own: unknown;
    try {
      own = (JSON.parse(res.body) as { event?: { own_participation?: number } }).event?.own_participation;
    } catch {
      throw new Error("MyClub answered with something other than JSON");
    }
    if (own !== want) throw new Error(`MyClub didn't record it (status ${String(own)}); answer in MyClub`);
    return attend ? "signed up" : "declined";
  }
}

/**
 * Unanswered invitations read from the logged-in event pages, read-only.
 * MyClub's "Ei vastausta" calendar feed misses many open events, so the poll
 * uses this: every club event in the date window whose page shows the child's
 * Osallistun / En osallistu buttons with neither one chosen.
 */
export class MyClubInvites implements MyClubProvider {
  constructor(
    private clubs: { host: string; child: string }[],
    private days = 16,
    private reader = new MyClubWriter(),
  ) {}

  async fetch(cfg: Config): Promise<MyClubSnapshot> {
    const { load } = await import("cheerio");
    const from = localParts(new Date()).date;
    const to = addDays(from, this.days);
    const months = new Set([from.slice(0, 7), to.slice(0, 7)]);
    const events: MyClubEvent[] = [];
    const warnings: string[] = [];
    for (const { host, child } of this.clubs) {
      const list = (await this.reader.listEvents(host, child)).filter((e) => months.has(String(e.month).slice(0, 7)));
      for (const item of list) {
        const page = await this.reader.peek(host, `/flow/events/${item.id}`);
        const $ = load(page.body);
        const buttons = $(".event-indication-buttons a[data-indication]").first().parent().find("a[data-indication]");
        if (!buttons.length) continue; // not invited
        if (buttons.is(".btn-success, .btn-danger, .btn-warning")) continue; // already answered
        // The details block reads "25.10.2026 15:30 - 17:00"; other dates on the page (published, comments) have no range.
        const text = $("body").text().replace(/\s+/g, " ");
        const when =
          text.match(/(\d{1,2})\.(\d{1,2})\.(\d{4}) (\d{1,2}):(\d{2}) ?- ?(?:\d{1,2}\.\d{1,2}\.\d{4} )?(\d{1,2}):(\d{2})/) ??
          text.match(/(\d{1,2})\.(\d{1,2})\.(\d{4}) ?- ?\d{1,2}\.\d{1,2}\.\d{4}/) ??
          text.match(/Näytä kartalla (\d{1,2})\.(\d{1,2})\.(\d{4})/);
        if (!when) {
          warnings.push(`no date on ${host} event ${item.id}`);
          continue;
        }
        const [, d, m, y, h1, m1, h2, m2] = when;
        const date = `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
        if (date < from || date > to) continue;
        const at = (h?: string, mm?: string) => ({ dateTime: fromLocal(date, `${h!.padStart(2, "0")}:${mm}`).toISOString() });
        events.push({
          id: `myclub-${host.split(".")[0]}-${item.id}`,
          child,
          club: host.split(".")[0],
          title: String(item.name).trim(),
          start: h1 ? at(h1, m1) : { date },
          end: h2 ? at(h2, m2) : h1 ? at(h1, m1) : { date: addDays(date, 1) },
          location: String(item.venue ?? "").trim() || undefined,
          url: `https://${host}/flow/events/${item.id}`,
        });
      }
    }
    return { fetchedAt: new Date().toISOString(), route: "pages", events, invoices: [], warnings };
  }
}
