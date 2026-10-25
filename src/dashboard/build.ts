import { readFileSync } from "node:fs";
import type { Config } from "../config.js";
import type { StateData } from "../lib/state.js";
import { addDays, localParts } from "../lib/time.js";
import { esc } from "../notify/telegram.js";
import { feesDue, openSignups, type MyClubSnapshot } from "../sources/myclub.js";
import type { WilmaSnapshot } from "../sources/wilma.js";
import { isoWeek } from "../digest/week-plan.js";
import { conflicts, isComingUp, localTitles, mergeCrossCalendar, splitTitle, type HubEvent } from "../digest/build.js";

// The family dashboard: one picture pinned in the family group and edited in
// place whenever its content changes. Laid out in the Kunto design system
// (henrijantti/health-coach kunto/design-system): the verdict first (today),
// big bold numbers, labels whispering in capitals, violet marks today and
// what's next, amber/red only for something to act on, white cards floating
// on a cool grey ground. Finnish, no bills (the group sees it).

export interface DashEvent {
  date: string;
  start?: string;
  end?: string;
  who?: string;
  what: string;
  place?: string;
  cancelled: boolean;
  tentative: boolean;
  /** Today only: already over. */
  past: boolean;
  /** Today only: started, not over. */
  ongoing: boolean;
  startMs: number;
}

export interface Notice {
  pill: string;
  tone: "accent" | "warning" | "critical";
  text: string;
}

export interface KidTile {
  name: string;
  count: number;
  next?: DashEvent;
  school?: string;
}

export interface DashModel {
  today: string;
  week: number;
  todayEvents: DashEvent[];
  notices: Notice[];
  /** Notices left out to keep the picture short. */
  moreNotices: number;
  days: { date: string; events: DashEvent[] }[];
  kids: KidTile[];
}

export interface DashInput {
  now: Date;
  cfg: Config;
  /** Hub events from today through the next 7 days. */
  events: HubEvent[];
  wilma?: WilmaSnapshot;
  myclub?: MyClubSnapshot;
  health: StateData["health"];
}

const DAYS = ["Sunnuntai", "Maanantai", "Tiistai", "Keskiviikko", "Torstai", "Perjantai", "Lauantai"];
const SHORT = ["su", "ma", "ti", "ke", "to", "pe", "la"];
const wd = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();
const dm = (date: string) => {
  const [, m, d] = date.split("-").map(Number);
  return `${d}.${m}.`;
};
const short = (date: string) => `${SHORT[wd(date)]} ${dm(date)}`;

export function dashboardModel(inp: DashInput): DashModel {
  const now = localParts(inp.now);
  const today = now.date;
  const end = addDays(today, 6);
  const events = localTitles(mergeCrossCalendar(inp.events), "fi").filter((e) => e.date >= today && e.date <= end);
  const view = (e: HubEvent): DashEvent => {
    const cancelled = /^CANCELLED: /.test(e.title);
    const { who, what } = splitTitle(e.title.replace(/^CANCELLED: /, ""));
    return {
      date: e.date,
      start: e.start,
      end: e.end,
      who,
      what,
      place: e.location?.split(",")[0].trim() || undefined,
      cancelled,
      tentative: e.tentative,
      past: e.date === today && !!e.start && e.endMs <= inp.now.getTime(),
      ongoing: e.date === today && !!e.start && e.startMs <= inp.now.getTime() && e.endMs > inp.now.getTime(),
      startMs: e.startMs,
    };
  };

  const notices: Notice[] = [];
  const failing = Object.entries(inp.health).filter(([, h]) => !h.ok).map(([s]) => s);
  for (const s of failing) notices.push({ pill: "Ei yhteyttä", tone: "critical", text: `${s} ei vastannut, tietoja voi puuttua` });
  const hm = (ms: number) => localParts(new Date(ms)).time;
  for (let i = 0; i < 7; i++) {
    const day = addDays(today, i);
    for (const [a, b] of conflicts(events.filter((e) => e.date === day))) {
      const x = splitTitle(a.title);
      const y = splitTitle(b.title);
      const same = !!x.who && x.who === y.who;
      const names = same ? `${x.who}: ${x.what} ja ${y.what}` : `${x.who ?? x.what} ja ${y.who ?? y.what}`;
      notices.push({ pill: "Päällekkäin", tone: "warning", text: `${short(day)} ${hm(Math.max(a.startMs, b.startMs))}–${hm(Math.min(a.endMs, b.endMs))} ${names}, kuka vie?` });
    }
  }
  if (inp.myclub) {
    for (const e of openSignups(inp.myclub, today, 7)) notices.push({ pill: "Ilmoittaudu", tone: "accent", text: `${e.child ? `${e.child}: ` : ""}${e.title}, viimeistään ${short(e.signup!.deadline!)}` });
    for (const f of feesDue(inp.myclub, today, 7)) {
      const late = f.dueDate < today;
      notices.push({ pill: late ? "Myöhässä" : "Maksu", tone: late ? "critical" : "warning", text: `${f.club} ${f.amount}, eräpäivä ${short(f.dueDate)}` });
    }
  }
  for (const e of events.filter((x) => x.date > today && isComingUp(x.title) && !/^CANCELLED/.test(x.title))) {
    const { who, what } = splitTitle(e.title);
    const exam = /exam|koe\b|kokeet/i.test(e.title);
    notices.push({ pill: exam ? "Koe" : "Peli", tone: "accent", text: `${short(e.date)}${e.start ? ` ${e.start}` : ""} ${who ? `${who}: ` : ""}${what}` });
  }

  const kids: KidTile[] = inp.cfg.children.map((c) => {
    const mine = events.filter((e) => splitTitle(e.title).who === c.name && !/^CANCELLED/.test(e.title)).map(view);
    const st = inp.wilma?.students.find((s) => s.name === c.name);
    const lessons = (st?.lessons ?? []).filter((l) => l.date === today).sort((a, b) => a.start.localeCompare(b.start));
    return {
      name: c.name,
      count: mine.length,
      next: mine.find((e) => !e.past && !e.ongoing && e.start) ?? mine.find((e) => !e.past && !e.ongoing),
      school: lessons.length ? `${lessons[0].start}–${lessons[lessons.length - 1].end}` : undefined,
    };
  });

  return {
    today,
    week: isoWeek(today),
    todayEvents: events.filter((e) => e.date === today).map(view),
    notices: notices.slice(0, 5),
    moreNotices: Math.max(0, notices.length - 5),
    days: Array.from({ length: 6 }, (_, i) => addDays(today, i + 1)).map((date) => ({ date, events: events.filter((e) => e.date === date).map(view) })),
    kids,
  };
}

// ---------- rendering ----------

const FONT = new URL("../../assets/manrope-latin.woff2", import.meta.url);
let fontData: string | undefined;
function font(): string {
  try {
    fontData ??= readFileSync(FONT).toString("base64");
  } catch {
    fontData = "";
  }
  return fontData;
}

const KUNTO = `
:root{--app:#f3f4f9;--surface:#fff;--chip:#f4f4fa;--line:#e6e7f0;--line-soft:#eeeff5;--sunken:#ecedf4;
--ink:#191b2b;--ink-soft:#2f3247;--ink-muted:#4a4d63;--ink-subtle:#646780;
--primary:#5a5ad6;--primary-soft:#ededfc;--primary-ink:#3f3fb4;--series-1:#2f2f99;--series-2:#6464d9;
--success:#17895f;--success-soft:#e3f5ec;--success-ink:#0f6b49;
--warning-strong:#b7780a;--warning-soft:#fbf1dc;--warning-ink:#82540a;
--critical:#c8413a;--critical-soft:#fbe8e6;--critical-ink:#a3302a;
--shadow-xs:0 1px 2px rgba(25,27,43,.04),0 6px 24px -12px rgba(25,27,43,.10)}
*{box-sizing:border-box;margin:0;padding:0}
html,body{background:var(--app)}
body{width:600px;padding:20px 16px 18px;font-family:Manrope,system-ui,sans-serif;color:var(--ink);font-size:14px;line-height:20px;
-webkit-font-smoothing:antialiased;font-variant-numeric:tabular-nums}
.label{font-size:11px;line-height:14px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-subtle)}
.head{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;margin:0 4px 16px}
.head h1{font-size:30px;line-height:36px;font-weight:800;letter-spacing:-.01em;margin-top:4px}
.brand{display:flex;align-items:center;gap:8px}
.brand svg{width:26px;height:26px}
.fresh{text-align:right}
.fresh b{display:block;font-size:14px;line-height:20px;font-weight:700;color:var(--ink-muted);margin-top:2px}
.card{background:var(--surface);border-radius:16px;box-shadow:var(--shadow-xs);padding:20px;margin-bottom:16px}
.card h2{font-size:15px;line-height:22px;font-weight:700;margin-bottom:12px;display:flex;justify-content:space-between;align-items:baseline}
.card h2 .label{font-size:11px}
.verdict{font-size:22px;line-height:28px;font-weight:800;margin:2px 0 4px}
.sub{color:var(--ink-muted);font-weight:600;margin-bottom:14px}
.sub b{color:var(--primary-ink);font-weight:800}
.agenda{display:grid;gap:8px}
.ev{display:grid;grid-template-columns:64px 1fr;gap:12px;align-items:start;padding:10px 12px;border-radius:12px;box-shadow:inset 0 0 0 1px var(--line)}
.ev.next{box-shadow:inset 0 0 0 2px var(--primary);background:var(--primary-soft)}
.ev.past{opacity:.5}
.ev .t{font-weight:800;font-size:18px;line-height:24px}
.ev .t small{display:block;font-size:11px;line-height:14px;font-weight:700;color:var(--ink-subtle);letter-spacing:.02em}
.ev .w{font-weight:700;line-height:20px}
.ev .w s{color:var(--ink-subtle)}
.ev .p{color:var(--ink-subtle);font-size:12px;line-height:16px;margin-top:2px}
.who{display:inline-block;font-size:11px;line-height:14px;font-weight:800;letter-spacing:.03em;padding:4px 8px;border-radius:999px;background:var(--chip);color:var(--ink-muted);margin-right:6px;vertical-align:1px}
.who.k0{background:var(--primary-soft);color:var(--primary-ink)}
.who.k1{background:#e6f0fb;color:#1f5a96}
.pill{display:inline-flex;align-items:center;height:22px;padding:0 9px;border-radius:999px;font-size:11px;font-weight:800;letter-spacing:.03em;white-space:nowrap}
.pill.accent{background:var(--primary-soft);color:var(--primary-ink)}
.pill.warning{background:var(--warning-soft);color:var(--warning-ink)}
.pill.critical{background:var(--critical-soft);color:var(--critical-ink)}
.pill.grey{background:var(--chip);color:var(--ink-muted)}
.pill.ghost{box-shadow:inset 0 0 0 1px var(--line);color:var(--ink-subtle)}
.notes{display:grid;gap:10px}
.note{display:grid;grid-template-columns:96px 1fr;gap:10px;align-items:start}
.note .pill{justify-self:start}
.note span:last-child{font-weight:600;color:var(--ink-soft);line-height:20px;padding-top:1px}
.days{display:grid}
.day{display:grid;grid-template-columns:52px 1fr;gap:12px;padding:10px 0;border-top:1px solid var(--line-soft)}
.day:first-child{border-top:0;padding-top:0}
.date{display:grid;justify-items:center;align-content:start;border-radius:10px;box-shadow:inset 0 0 0 1px var(--line);padding:5px 0 6px}
.date .label{font-size:10px;line-height:12px}
.date b{font-size:20px;line-height:24px;font-weight:800}
.date.we{background:var(--chip);box-shadow:none}
.items{display:grid;gap:4px;align-content:center;min-height:44px}
.it{display:flex;gap:8px;align-items:baseline;line-height:20px;min-width:0}
.it .tm{font-weight:800;width:44px;flex:none}
.it .wt{font-weight:600;color:var(--ink-soft);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pl{color:var(--ink-subtle);font-size:12px;white-space:nowrap}
.more{color:var(--ink-subtle);font-size:12px;font-weight:700;padding-left:52px}
.kids{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.kid{background:var(--chip);border-radius:12px;padding:14px}
.kid .top{display:flex;align-items:center;gap:8px;margin-bottom:8px}
.av{width:28px;height:28px;border-radius:999px;display:grid;place-items:center;font-weight:800;font-size:13px;background:var(--primary-soft);color:var(--primary-ink)}
.av.k1{background:#e6f0fb;color:#1f5a96}
.kid .n{font-weight:700;font-size:15px}
.kid .fig{font-size:26px;line-height:32px;font-weight:800}
.kid .fig small{font-size:11px;line-height:14px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-subtle);margin-left:6px}
.kid .nx{margin-top:6px;font-size:12px;line-height:16px;color:var(--ink-muted);font-weight:600}
.kid .nx b{color:var(--ink);font-weight:800}
.empty{color:var(--ink-subtle);font-weight:600}
`;

const MARK = `<svg viewBox="0 0 30 30" aria-hidden="true"><circle cx="15" cy="15" r="13" fill="none" stroke="var(--primary-soft)" stroke-width="4"/><path d="M15 2a13 13 0 0 1 12.4 9" fill="none" stroke="var(--primary)" stroke-width="4" stroke-linecap="round"/><path d="M9.5 14.5 15 10l5.5 4.5V20h-11z" fill="none" stroke="var(--primary)" stroke-width="2" stroke-linejoin="round"/></svg>`;

function kidClass(cfg: Config, who?: string): string {
  const i = cfg.children.findIndex((c) => c.name === who);
  return i >= 0 ? ` k${i % 2}` : "";
}

function whoPill(cfg: Config, who?: string): string {
  return who ? `<span class="who${kidClass(cfg, who)}">${esc(who)}</span>` : "";
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function renderDashboard(m: DashModel, cfg: Config, updated?: string): string {
  const live = m.todayEvents.filter((e) => !e.cancelled);
  const next = live.find((e) => !e.past && !e.ongoing && e.start);
  const verdict = live.length ? plural(live.length, "meno tänään", "menoa tänään") : "Vapaa päivä";
  const sub = next
    ? `Seuraavaksi <b>${next.start ?? "koko päivän"}</b> ${esc(next.who ? `${next.who} · ` : "")}${esc(next.what)}`
    : live.some((e) => e.ongoing)
      ? "Viimeinen meno on käynnissä"
      : live.some((e) => e.start)
      ? "Päivän menot on menty"
      : live.length
        ? "Vain koko päivän merkintöjä"
        : "Ei kalenterimerkintöjä tälle päivälle";

  const agenda = m.todayEvents
    .slice(0, 6)
    .map((e) => {
      const cls = e === next || e.ongoing ? " next" : e.past || e.cancelled ? " past" : "";
      const time = e.start ? `${e.start}${e.end ? `<small>–${e.end}</small>` : ""}` : `<small>koko päivä</small>`;
      const what = e.cancelled ? `<s>${esc(e.what)}</s> <span class="pill grey">Peruttu</span>` : esc(e.what);
      const tent = (e.ongoing && !e.cancelled ? ` <span class="pill accent">Käynnissä</span>` : "") + (e.tentative && !e.cancelled ? ` <span class="pill ghost">Alustava</span>` : "");
      return `<div class="ev${cls}"><div class="t">${time}</div><div><div class="w">${whoPill(cfg, e.who)}${what}${tent}</div>${e.place ? `<div class="p">${esc(e.place)}</div>` : ""}</div></div>`;
    })
    .join("");
  const extra = m.todayEvents.length > 6 ? `<div class="more">+${m.todayEvents.length - 6} muuta</div>` : "";

  const notices = m.notices.length
    ? `<section class="card"><h2>Huomioitavaa <span class="label">${m.notices.length + m.moreNotices} ${m.notices.length + m.moreNotices === 1 ? "asia" : "asiaa"}</span></h2><div class="notes">${m.notices
        .map((n) => `<div class="note"><span class="pill ${n.tone}">${esc(n.pill)}</span><span>${esc(n.text)}</span></div>`)
        .join("")}${m.moreNotices ? `<div class="note"><span></span><span class="pl">+${m.moreNotices} muuta</span></div>` : ""}</div></section>`
    : "";

  const days = m.days
    .map((d) => {
      const w = wd(d.date);
      const items = d.events.filter((e) => !e.cancelled);
      const shown = items.slice(0, 3);
      const rows = shown.length
        ? shown
            .map((e) => `<div class="it"><span class="tm">${e.start ?? `<span class="pl">koko pv</span>`}</span><span class="wt">${whoPill(cfg, e.who)}${esc(e.what)}</span>${e.place ? `<span class="pl">${esc(e.place)}</span>` : ""}</div>`)
            .join("") + (items.length > 3 ? `<div class="it"><span class="tm"></span><span class="pl">+${items.length - 3} muuta</span></div>` : "")
        : `<div class="it"><span class="pill grey">Vapaa</span></div>`;
      const [, , dd] = d.date.split("-").map(Number);
      return `<div class="day"><div class="date${w === 0 || w === 6 ? " we" : ""}"><span class="label">${SHORT[w]}</span><b>${dd}</b></div><div class="items">${rows}</div></div>`;
    })
    .join("");

  const kids = m.kids.length
    ? `<section class="card"><h2>Lapset <span class="label">7 päivää</span></h2><div class="kids">${m.kids
        .map((k, i) => {
          const nx = k.next
            ? `Seuraavaksi <b>${k.next.date === m.today ? "tänään" : short(k.next.date)}${k.next.start ? ` ${k.next.start}` : ""}</b> ${esc(k.next.what)}`
            : "Ei menoja 7 päivään";
          return `<div class="kid"><div class="top"><span class="av k${i % 2}">${esc(k.name.slice(0, 1))}</span><span class="n">${esc(k.name)}</span></div><div class="fig">${k.count}<small>${k.count === 1 ? "meno" : "menoa"}</small></div>${k.school ? `<div class="nx">Koulu tänään <b>${k.school}</b></div>` : ""}<div class="nx">${nx}</div></div>`;
        })
        .join("")}</div></section>`
    : "";

  const f = font();
  return `<!doctype html><html lang="fi"><head><meta charset="utf-8"><title>Perheen viikko</title><style>${
    f ? `@font-face{font-family:Manrope;font-weight:200 800;src:url(data:font/woff2;base64,${f}) format("woff2")}` : ""
  }${KUNTO}</style></head><body>
<header class="head"><div><div class="brand">${MARK}<span class="label">Perhe · viikko ${m.week}</span></div><h1>${DAYS[wd(m.today)]} ${dm(m.today)}</h1></div>${
    updated ? `<div class="fresh"><span class="label">Päivitetty</span><b>${esc(updated)}</b></div>` : ""
  }</header>
<section class="card"><h2>Tänään <span class="label">${short(m.today)}</span></h2><div class="verdict">${verdict}</div><div class="sub">${sub}</div><div class="agenda">${agenda}</div>${extra}</section>
${notices}
<section class="card"><h2>Tulevat päivät <span class="label">${short(m.days[0].date)}–${short(m.days[m.days.length - 1].date)}</span></h2><div class="days">${days}</div></section>
${kids}
</body></html>`;
}
