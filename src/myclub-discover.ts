import { env, requireEnv, type Config } from "./config.js";
import { IcsMyClub } from "./sources/myclub.js";

// Read-only discovery of MyClub's login and sign-up pages, run once on GitHub
// (which holds the login secrets) to learn how sign-ups work. It never submits
// anything except the login form, and prints page structure only: form
// actions, field names and types, button labels and link paths, with numbers
// masked. No field values, names or message text.

const mask = (s: string) => s.replace(/\d+/g, "N").replace(/([?&](token|key|code|state|nonce)[^=]*=)[^&]+/gi, "$1…");

class Jar {
  private byHost = new Map<string, Map<string, string>>();
  header(host: string) {
    const out: string[] = [];
    for (const [h, m] of this.byHost) if (host === h || host.endsWith(`.${h}`)) for (const [k, v] of m) out.push(`${k}=${v}`);
    return out.join("; ");
  }
  store(host: string, setCookies: string[]) {
    for (const c of setCookies) {
      const parts = c.split(";").map((p) => p.trim());
      const [kv] = parts;
      const i = kv.indexOf("=");
      const dom = parts.find((p) => /^domain=/i.test(p))?.slice(7).replace(/^\./, "") ?? host;
      if (!this.byHost.has(dom)) this.byHost.set(dom, new Map());
      this.byHost.get(dom)!.set(kv.slice(0, i), kv.slice(i + 1));
    }
  }
}

export async function discoverMyClub(cfg: Config, log = console.log) {
  const { load } = await import("cheerio");
  const jar = new Jar();
  const get = async (url: string, init: RequestInit = {}, hops = 0): Promise<{ status: number; url: string; html: string }> => {
    const u = new URL(url);
    if (!u.hostname.endsWith("myclub.fi")) throw new Error(`refusing off-site URL ${u.hostname}`);
    const res = await fetch(url, {
      ...init,
      redirect: "manual",
      headers: { "user-agent": "Mozilla/5.0 family-agent", ...(init.headers ?? {}), cookie: jar.header(u.hostname) },
    });
    jar.store(u.hostname, res.headers.getSetCookie?.() ?? []);
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc && hops < 10) {
      log(`    ${res.status} -> ${mask(new URL(loc, url).toString())}`);
      return get(new URL(loc, url).toString(), {}, hops + 1);
    }
    return { status: res.status, url, html: await res.text() };
  };

  const describe = (title: string, page: { status: number; url: string; html: string }) => {
    const $ = load(page.html);
    log(`\n== ${title}: ${page.status} ${mask(page.url)}`);
    log(`  title: ${mask($("title").text().trim()).slice(0, 80)}  scripts: ${$("script[src]").length}  forms: ${$("form").length}`);
    $("form").each((i, f) => {
      log(`  form ${i}: ${($(f).attr("method") ?? "get").toUpperCase()} ${mask($(f).attr("action") ?? "")}`);
      $(f)
        .find("input, select, textarea, button")
        .each((_, el) => {
          const t = $(el);
          const tag = el.tagName;
          const label = tag === "button" || t.attr("type") === "submit" ? ` "${mask((t.text() || t.attr("value") || "").trim()).slice(0, 40)}"` : "";
          log(`    ${tag} name=${t.attr("name") ?? "-"} type=${t.attr("type") ?? "-"}${label}`);
        });
    });
    const buttons = new Set<string>();
    $("button, a.btn, [role=button], input[type=submit]").each((_, el) => {
      const t = mask(($(el).text() || $(el).attr("value") || "").replace(/\s+/g, " ").trim()).slice(0, 40);
      if (t) buttons.add(t);
    });
    if (buttons.size) log(`  buttons: ${[...buttons].slice(0, 25).join(" | ")}`);
    const paths = new Set<string>();
    $("a[href]").each((_, a) => {
      try {
        const u = new URL($(a).attr("href")!, page.url);
        if (u.hostname.endsWith("myclub.fi")) paths.add(mask(`${u.hostname}${u.pathname}`));
      } catch {}
    });
    log(`  link paths (${paths.size}): ${[...paths].slice(0, 40).join("  ")}`);
    const attrs = new Set<string>();
    $("[data-action], [data-url], [data-remote], [data-method]").each((_, el) => {
      for (const k of ["data-action", "data-url", "data-method"]) if ($(el).attr(k)) attrs.add(`${k}=${mask($(el).attr(k)!)}`);
    });
    if (attrs.size) log(`  data attrs: ${[...attrs].slice(0, 20).join("  ")}`);
  };

  // 1. Login page candidates.
  const candidates = [env("MYCLUB_LOGIN_URL"), "https://id.myclub.fi/", "https://id.myclub.fi/users/sign_in", "https://myclub.fi/login"].filter(Boolean) as string[];
  let login: { status: number; url: string; html: string } | undefined;
  for (const c of candidates) {
    try {
      const p = await get(c);
      describe(`candidate ${c}`, p);
      if (!login && load(p.html)("input[type=password]").length) login = p;
    } catch (e) {
      log(`\n== candidate ${c}: ${(e as Error).message}`);
    }
  }
  if (!login) {
    log("\nNo password form found on any candidate page; the login may be a script-driven page or an emailed code.");
    return;
  }

  // 2. Log in (the only form this ever submits).
  const $ = load(login.html);
  const form = $("form").filter((_, f) => $(f).find("input[type=password]").length > 0).first();
  const fields = new URLSearchParams();
  form.find("input").each((_, i) => {
    const name = $(i).attr("name");
    if (!name) return;
    const type = ($(i).attr("type") ?? "text").toLowerCase();
    if (type === "password") fields.set(name, requireEnv("MYCLUB_PASSWORD"));
    else if (type === "email" || /user|email|login/i.test(name)) fields.set(name, requireEnv("MYCLUB_USERNAME"));
    else if (type !== "checkbox" && type !== "submit") fields.set(name, $(i).attr("value") ?? "");
  });
  const action = new URL(form.attr("action") ?? login.url, login.url).toString();
  log(`\n== logging in: POST ${mask(action)} fields: ${[...fields.keys()].join(", ")}`);
  const home = await get(action, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: fields });
  const refused = load(home.html)("input[type=password]").length > 0;
  describe(refused ? "after login (STILL SHOWS A PASSWORD FIELD: login refused?)" : "after login", home);
  if (refused) return;

  // 3. Event pages: unanswered invitations from the poll feed, else the calendar feed.
  for (const envName of ["MYCLUB_POLL_ICS_URL", "MYCLUB_ICS_URL"]) {
    if (!env(envName)) continue;
    const snap = await new IcsMyClub(envName).fetch(cfg);
    const withUrl = snap.events.filter((e) => e.url);
    log(`\n== ${envName}: ${snap.events.length} events, ${withUrl.length} with a URL; url patterns: ${[...new Set(withUrl.map((e) => mask(e.url!)))].slice(0, 5).join("  ")}`);
    for (const e of withUrl.slice(0, 2)) {
      try {
        describe(`event page (${envName})`, await get(e.url!));
      } catch (err) {
        log(`  event page: ${(err as Error).message}`);
      }
    }
    if (withUrl.length) break;
  }
}
