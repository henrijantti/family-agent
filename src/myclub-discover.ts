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
  const candidates = [env("MYCLUB_LOGIN_URL"), "https://id.myclub.fi/flow/login"].filter(Boolean) as string[];
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

  // 3. Club context: each club keeps one active member account (child) per session.
  describe("ppj select_account", await get("https://ppj.myclub.fi/flow/select_account"));

  // 4. Events list: how the page loads event details.
  const list = await get("https://ppj.myclub.fi/flow/events");
  describe("ppj events list", list);
  const $l = load(list.html);
  const sample = $l("[data-url], [data-id], [data-event-id], [data-href]").slice(0, 4);
  sample.each((_, el) => {
    const a = Object.entries(el.attribs).map(([k, v]) => `${k}=${mask(v).slice(0, 60)}`);
    log(`  element <${el.tagName}> ${a.join(" ")}`);
  });
  const classes = new Set<string>();
  $l("[class]").each((_, el) => $l(el).attr("class")!.split(/\s+/).forEach((c) => /event|enroll|attend|osall|ilmo|signup|registr/i.test(c) && classes.add(c)));
  log(`  event-ish classes: ${[...classes].slice(0, 30).join(" ")}`);
  const inline = $l("script:not([src])").map((_, el) => $l(el).text()).get().join("\n");
  const urls = new Set(inline.match(/["'](\/flow\/[^"'\s]+)["']/g) ?? []);
  log(`  urls in inline scripts: ${[...urls].map(mask).slice(0, 20).join("  ")}`);

  // 5. Event JSON on the list page: keys and value types only.
  const raw = $l("#events").attr("data-events");
  let first: Record<string, unknown> | undefined;
  if (raw) {
    const arr = JSON.parse(raw) as Record<string, unknown>[];
    first = arr[0];
    const keys = new Map<string, Set<string>>();
    for (const ev of arr) for (const [k, v] of Object.entries(ev)) {
      if (!keys.has(k)) keys.set(k, new Set());
      const shown = /status|state|enroll|regist|attend|particip|answer|can_|allow|deadline|type|kind/i.test(k) ? JSON.stringify(v).slice(0, 40) : Array.isArray(v) ? "array" : typeof v;
      keys.get(k)!.add(mask(shown));
    }
    log(`  data-events: ${arr.length} events; keys:`);
    for (const [k, vs] of keys) log(`    ${k}: ${[...vs].slice(0, 6).join(" | ")}`);
  }

  // 6. The app script: how details are fetched and answers are sent.
  for (const src of $l("script[src]").map((_, el) => $l(el).attr("src")).get()) {
    const url = new URL(src, list.url).toString();
    if (!new URL(url).hostname.endsWith("myclub.fi")) continue;
    const js = (await get(url)).html;
    const hits = new Set<string>();
    for (const m of js.matchAll(/.{0,60}(\/flow\/[a-z_\/]*(event|enroll|particip|attend|regist|answer|details)[a-z_\/]*).{0,80}/gi)) hits.add(m[0].replace(/\s+/g, " "));
    for (const m of js.matchAll(/.{0,80}(participation|enrollment|registration|attendance)[A-Za-z_]*.{0,80}/g)) if (hits.size < 60) hits.add(m[0].replace(/\s+/g, " "));
    log(`\n== script ${mask(new URL(url).pathname)} (${js.length} bytes): ${hits.size} relevant snippets`);
    for (const h of [...hits].slice(0, 60)) log(`  ${h.slice(0, 220)}`);
  }

  // 7. Details request variants for one upcoming event.
  if (first?.id) {
    for (const [label, path, headers] of [
      ["xhr id", `/flow/events/details?id=${first.id}`, { "x-requested-with": "XMLHttpRequest", accept: "text/html, */*" }],
      ["xhr event_id", `/flow/events/details?event_id=${first.id}`, { "x-requested-with": "XMLHttpRequest", accept: "text/html, */*" }],
      ["json", `/flow/events/${first.id}.json`, { accept: "application/json" }],
    ] as const) {
      try {
        const d = await get(`https://ppj.myclub.fi${path}`, { headers: headers as Record<string, string> });
        log(`\n== details ${label}: ${d.status}, ${d.html.length} bytes`);
        if (d.html.length > 50) describe(`details ${label}`, d);
      } catch (err) {
        log(`  details ${label}: ${(err as Error).message}`);
      }
    }
  }
}
