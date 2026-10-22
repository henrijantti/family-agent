import { requireEnv } from "../config.js";
import type { AttendanceWriter, PollOption } from "../attendance.js";

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
