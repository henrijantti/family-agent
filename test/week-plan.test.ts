import assert from "node:assert/strict";
import { test } from "node:test";
import type { HubEvent } from "../src/digest/build.js";
import { buildWeekPlan, euros, isoWeek, mergeBills, parseAmount, type WeekPlanInput } from "../src/digest/week-plan.js";
import { localIso } from "../src/lib/time.js";

const NOW = new Date("2026-10-25T15:30:00Z"); // Sun 25.10. 17:30 Helsinki

function ev(calendar: HubEvent["calendar"], title: string, date: string, start?: string, end?: string, location?: string): HubEvent {
  const s = Date.parse(localIso(date, start ?? "00:00"));
  const e = end ? Date.parse(localIso(date, end)) : s + 86400000;
  return { calendar, title, date, start, end, startMs: s, endMs: e, location, tentative: false };
}

function input(over: Partial<WeekPlanInput> = {}): WeekPlanInput {
  return {
    now: NOW,
    format: "markdown",
    children: ["Oliver", "Oskar"],
    events: [
      ev("hobbies", "Oliver: K-E Blues 15: Jäävuoro", "2026-10-27", "17:00", "18:30", "Tapiolan jäähalli, Itätuulenkuja 4, Espoo"),
      ev("hobbies", "Oskar: PPJ: Taitokoulu 2017 -syntyneet Hallikausi 2026-2027", "2026-10-27", "17:30", "18:30", "Leppävaaran urheilupuisto, Espoo"),
      ev("school", "Oskar: Matematiikan koe", "2026-10-29"),
      ev("hobbies", "CANCELLED: Oliver: PPJ: Harjoitus", "2026-10-30", "18:00", "19:00", "Tali"),
      ev("family", "Oliver: Turnaus", "2026-10-31", "09:00", "15:00", "Raksila"),
      ev("hobbies", "Oliver: PPJ: Harjoitus", "2026-11-02", "18:00", "19:00"), // next week: left out
    ],
    bills: [
      { messageId: "m1", biller: "helen.fi", amount: "84.20", currency: "EUR", due: "2026-10-27", reference: "1232", ibanChanged: true },
      { messageId: "m2", biller: "Elisa Oyj", amount: "29,90 €", due: "2026-11-15" }, // after the week: left out
      { messageId: "m3", biller: "Taloyhtiö", amount: "1 250,00 €", due: "2026-10-30", reference: "RF18539007547034", newBiller: true },
    ],
    myclub: {
      fetchedAt: NOW.toISOString(),
      route: "fixture",
      warnings: [],
      invoices: [{ id: "i1", club: "PPJ", amount: "180,00 €", dueDate: "2026-10-31", reference: "12345672", paid: false }],
      events: [{ id: "e1", child: "Oskar", title: "PPJ: Halloween-turnaus", start: { date: "2026-11-07" }, end: { date: "2026-11-08" }, signup: { needed: true, deadline: "2026-10-28" } }],
    },
    wilma: {
      fetchedAt: NOW.toISOString(),
      baseUrl: "https://helsinki.inschool.fi",
      students: [
        {
          name: "Oskar",
          number: "1",
          lessons: [],
          homework: [],
          messages: [],
          news: [],
          notes: [],
          exams: [{ id: 7, date: "2026-10-29", subject: "Matematiikka", name: "Koe", topic: "Kertotaulut 1-5" }],
        },
      ],
    },
    queue: [{ child: "Oskar", kind: "message", text: "Retkilupa palautettava perjantaihin mennessä", action: true }],
    health: { "MyClub": { ok: true, at: NOW.toISOString() }, "Google calendar (family)": { ok: false, at: NOW.toISOString() } },
    ...over,
  };
}

test("week plan: helpers", () => {
  assert.equal(isoWeek("2026-10-26"), 44);
  assert.equal(isoWeek("2027-01-01"), 53);
  assert.equal(parseAmount("84.20"), 84.2);
  assert.equal(parseAmount("1 250,00 €"), 1250);
  assert.equal(parseAmount("1.250,00 €"), 1250);
  assert.equal(parseAmount("noin satanen"), undefined);
  assert.equal(euros(1334.2), "1 334,20 €");
});

test("week plan: Henri's layout, every section, nothing from next week", () => {
  const out = buildWeekPlan(input());
  console.log(`\n${out}\n`);
  const sections = out.split("\n\n").filter((p) => /^[^•\s]\S* \*\*/.test(p)).map((p) => p.split("\n")[0]);
  assert.deepEqual(sections, [
    "🗓 **Viikkosuunnitelma, vk 44**",
    "✅ **Hoida tällä viikolla**",
    "📝 **Kokeet**",
    "🚗 **Kuljetukset**",
    "📅 **Tiistai 27.10.**",
    "📅 **Torstai 29.10.**",
    "📅 **Perjantai 30.10.**",
    "📅 **Lauantai 31.10.**",
    "📊 **Viikko lyhyesti**",
    "🔧 **Lähteiden tila**",
  ]);
  // bills: changed account warned, new biller warned, later bill left out
  assert.match(out, /• \*\*helen\.fi\*\* 84,20 €\n eräpäivä ti 27\.10\. \(2 pv päästä\) · viite 1232\n ⚠️ tilinumero vaihtunut, tarkista ennen maksua/);
  assert.match(out, /• \*\*Taloyhtiö\*\* 1 250,00 €\n eräpäivä pe 30\.10\. \(5 pv päästä\) · viite RF18539007547034\n ⚠️ uusi laskuttaja/);
  assert.doesNotMatch(out, /Elisa/);
  assert.match(out, /• \*\*PPJ: kausimaksu\*\* 180,00 €\n eräpäivä la 31\.10\./);
  assert.match(out, /• \*\*Oskar: ilmoittautuminen\*\*\n Halloween-turnaus\n sulkeutuu ke 28\.10\./);
  assert.match(out, /• \*\*Oskar: Wilma\*\*\n Retkilupa/);
  assert.match(out, /• \*\*to 29\.10\.\*\* \*\*Oskar\*\* · Matematiikka\n Kertotaulut 1-5/);
  // clash: both boys on Tuesday evening in different places
  assert.match(out, /• \*\*ti 27\.10\.\*\* 17:30–18:30\n Oliver \(Tapiolan jäähalli\) ja Oskar \(Leppävaaran urheilupuisto\)\n kuka vie\?/);
  // event: time and who first, place on its own line, empty line between events
  assert.match(out, /• \*\*17:00–18:30\*\* \*\*Oliver\*\* · K-E Blues 15: Jäävuoro\n 📍 Tapiolan jäähalli\n\n• \*\*17:30–18:30\*\* \*\*Oskar\*\* · Taitokoulu 2017 -syntyneet\n 📍 Leppävaaran urheilupuisto/);
  assert.match(out, /~~\*\*18:00–19:00\*\* \*\*Oliver\*\* · PPJ: Harjoitus~~ peruttu/);
  assert.doesNotMatch(out, /2\.11\./);
  // summary: cancelled events don't count; a school all-day exam or a daytime tournament leaves the evening free
  assert.match(out, /• \*\*Oliver\*\*: 2 menoa\n• \*\*Oskar\*\*: 2 menoa\n• Vapaat illat: ma, ke, to, pe, la, su\n• Laskuja 2, yhteensä 1 334,20 €/);
  assert.match(out, /⚠️ Google calendar \(family\) ei vastannut/);
  // short lines, no raw ids or JSON
  assert.ok(out.split("\n").every((l) => l.length <= 80), "no long lines");
  assert.doesNotMatch(out, /m1|messageId|[{}]/);
});

test("week plan: HTML for Telegram escapes titles; Markdown can't be broken by a title", () => {
  const evil = [ev("family", "Oliver: <b>x</b> & *bold* _it_", "2026-10-28", "10:00", "11:00")];
  const html = buildWeekPlan(input({ format: "html", events: evil, bills: [], myclub: undefined, wilma: undefined, queue: [], health: {} }));
  assert.match(html, /<b>Oliver<\/b> · &lt;b&gt;x&lt;\/b&gt; &amp; \*bold\* _it_/);
  const md = buildWeekPlan(input({ events: evil, bills: [], myclub: undefined, wilma: undefined, queue: [], health: {} }));
  assert.match(md, /\*\*Oliver\*\* · <b>x<\/b> & bold it/);
});

test("week plan: a quiet week says so, and a free week is all free evenings", () => {
  const out = buildWeekPlan(input({ events: [], bills: [], myclub: undefined, wilma: undefined, queue: [], health: {} }));
  assert.match(out, /Ei kalenterimerkintöjä tälle viikolle\./);
  assert.match(out, /Vapaat illat: ma, ti, ke, to, pe, la, su/);
});

test("week plan: desk bills fill in what the scan missed and are named by domain only", () => {
  const merged = mergeBills(
    [{ messageId: "m1", biller: "Helen", sender: "lasku@helen.fi", subject: "Lasku", newBiller: false, foundAt: "2026-10-20T06:00:00Z" }],
    [
      { messageId: "m1", category: "bill", amount: "84.20", currency: "EUR", due: "2026-10-27", reference: "1232", sender: "lasku@helen.fi", fromPdf: true },
      { messageId: "m9", category: "bill", amount: "10.00", currency: "EUR", sender: "billing@evil.example", received: "2026-10-24T08:00:00Z" },
    ],
  );
  assert.deepEqual(merged, [
    { messageId: "m1", biller: "Helen", amount: "84.20", currency: "EUR", due: "2026-10-27", reference: "1232", newBiller: false, ibanChanged: undefined, found: "2026-10-20T06:00:00Z" },
    { messageId: "m9", biller: "evil.example", amount: "10.00", currency: "EUR", due: undefined, reference: undefined, newBiller: undefined, ibanChanged: undefined, found: "2026-10-24T08:00:00Z" },
  ]);
});

test("week plan: Finnish only, no English sync markers; a bill without due date says so and ages out", () => {
  const out = buildWeekPlan(
    input({
      events: [
        ev("school", "Oskar: Lokakuun tiedote 2026 (from bulletin)", "2026-10-30"),
        ev("school", "Oskar: Retki Nuuksioon (from bulletin)", "2026-10-28"),
        ev("hobbies", "Oliver: PPJ: Harjoitus (not going)", "2026-10-27", "18:00", "19:00"),
      ],
      bills: [
        { messageId: "b1", biller: "Bank Norwegian", amount: "170,29 €", found: "2026-10-23T07:00:00Z" },
        { messageId: "b2", biller: "Vanha", amount: "5,00 €", found: "2026-09-01T07:00:00Z" },
      ],
      myclub: undefined,
      wilma: undefined,
      queue: [],
      health: {},
    }),
  );
  assert.doesNotMatch(out, /from bulletin|not going/);
  assert.match(out, /Lokakuun tiedote 2026\n/);
  assert.match(out, /Retki Nuuksioon \(tiedote\)/);
  assert.match(out, /Harjoitus \(ei mene\)/);
  assert.match(out, /• \*\*Bank Norwegian\*\* 170,29 €\n eräpäivä puuttuu/);
  assert.doesNotMatch(out, /Vanha/);
});
