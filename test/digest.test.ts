import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { testConfig } from "./config.js";
import { FakeCalendar } from "../src/calendar/fake.js";
import { Ctx, tick } from "../src/jobs.js";
import { StateStore } from "../src/lib/state.js";
import { localIso } from "../src/lib/time.js";
import { ConsoleNotifier } from "../src/notify/telegram.js";
import { FixtureMyClub } from "../src/sources/myclub.js";
import { FixtureMail } from "../src/sources/outlook.js";
import { FixtureWilma, WilmaProvider } from "../src/sources/wilma.js";

const FIX = fileURLToPath(new URL("./fixtures/", import.meta.url));
Object.assign(process.env, {
  GOOGLE_FAMILY_CALENDAR_ID: "family",
  GOOGLE_SCHOOL_CALENDAR_ID: "school",
  GOOGLE_HOBBIES_CALENDAR_ID: "hobbies",
  TELEGRAM_FAMILY_CHAT_ID: "fam",
});
delete process.env.TELEGRAM_PRIVATE_CHAT_ID;

function ctx(now: string, wilma: WilmaProvider = new FixtureWilma(`${FIX}wilma.json`)) {
  const cal = new FakeCalendar();
  cal.seed("family", [
    { id: "h1", summary: "Eero: Football tournament", start: { date: "2026-10-25" }, end: { date: "2026-10-26" } },
    { id: "h2", summary: "Henri: dentist", start: { dateTime: localIso("2026-10-21", "17:00") }, end: { dateTime: localIso("2026-10-21", "17:45") } },
  ]);
  const notifier = new ConsoleNotifier(false);
  const c: Ctx = {
    cfg: testConfig(),
    state: new StateStore("/nonexistent/state.json").data,
    now: new Date(now),
    calendar: cal,
    wilma,
    myclub: new FixtureMyClub(`${FIX}myclub.json`),
    mail: new FixtureMail(`${FIX}outlook.json`),
    notifier,
    log: () => {},
  };
  return { c, cal, notifier };
}

test("morning tick: sources then one combined digest to the family group", async () => {
  const { c, cal, notifier } = ctx("2026-10-21T03:50:00Z"); // Wed 06:50 Helsinki
  const ran = await tick(c);
  assert.deepEqual(ran, ["myclub", "outlook", "wilma", "digest"]);
  assert.equal(notifier.sent.length, 1);
  const d = notifier.sent[0].html;
  assert.equal(notifier.sent[0].chatId, "fam");
  for (const s of ["Needs action", "Today", "Conflicts", "Coming up"]) assert.ok(d.includes(`<b>${s}</b>`), s);
  assert.match(d, /sign-up closes 2026-10-23/);
  assert.match(d, /• <b>Helen<\/b> 64,20 € · due Sat 24\.10\. \(in 3 d\)/);
  assert.match(d, /Aino: lessons 08:15–14:00/);
  // The tournament is on both the family and the hobbies calendar: listed once.
  const coming = d.split("<b>Coming up</b>")[1];
  assert.equal(coming.match(/Football tournament/g)!.length, 1);
  assert.match(d, /Football tournament <i>\(also on family calendar\)/);
  // No grades anywhere, and the calendars were written.
  assert.doesNotMatch(d, /grade|arvosana/i);
  assert.ok(cal.all("school").length >= 3);
  assert.equal(cal.all("hobbies").length, 4);
  // A second tick in the same window does nothing.
  assert.deepEqual(await tick(c), []);
});

test("bills_to none: the family digest carries no bills", async () => {
  const { c, notifier } = ctx("2026-10-21T03:50:00Z");
  c.cfg.outlook.bills_to = "none";
  await tick(c);
  assert.equal(notifier.sent.length, 1);
  assert.doesNotMatch(notifier.sent[0].html, /Helen|64,20/);
});

test("a failed Wilma read shows as a warning, not as an empty day", async () => {
  const broken: WilmaProvider = { fetch: async () => { throw new Error("login refused"); } };
  const { c, notifier } = ctx("2026-10-21T03:50:00Z", broken);
  await tick(c);
  assert.match(notifier.sent[0].html, /Wilma unavailable/);
});

test("midday Wilma run alerts on new action items, quiet hours hold alerts", async () => {
  const { c, notifier } = ctx("2026-10-21T03:50:00Z");
  await tick(c);
  notifier.sent.length = 0;
  const snapPath = `${FIX}wilma.json`;
  const base = new FixtureWilma(snapPath);
  c.wilma = {
    fetch: async (cfg, st) => {
      const s = await base.fetch(cfg);
      s.students[0].messages.push({ id: 9100, subject: "Vastaa kyselyyn", sentAt: "2026-10-21T08:00:00Z" });
      return s;
    },
  };
  c.now = new Date("2026-10-21T09:15:00Z"); // 12:15
  await tick(c);
  assert.equal(notifier.sent.length, 1);
  assert.match(notifier.sent[0].html, /Vastaa kyselyyn/);
});

test("Sunday week-ahead lists each day", async () => {
  const { c, notifier } = ctx("2026-10-25T17:20:00Z"); // Sun 19:20 Helsinki (UTC+2 after DST)
  await tick(c, ["myclub", "wilma", "week-ahead"]);
  const d = notifier.sent.at(-1)!.html;
  assert.match(d, /Week ahead/);
  assert.match(d, /<b>Wednesday 28\.10\.<\/b>\n• <b>all day<\/b> <b>Aino<\/b> · Kuvauspäivä \(from bulletin\)/);
});

test("event titles are shortened and conflicts say who overlaps when", async () => {
  const { splitTitle, conflicts, toHubEvent } = await import("../src/digest/build.js");
  assert.deepEqual(splitTitle("Oskar: Taitokoulut: Taitokoulu 2017 -syntyneet Hallikausi 2026-2027"), { who: "Oskar", what: "Taitokoulu 2017 -syntyneet" });
  assert.deepEqual(splitTitle("Oliver: K-E Blues 15: Jäävuoro"), { who: "Oliver", what: "K-E Blues 15: Jäävuoro" });
  assert.deepEqual(splitTitle("Henri: dentist"), { who: "Henri", what: "dentist" });
  const ev = (summary: string, from: string, to: string, location: string) =>
    toHubEvent({ id: summary, summary, location, start: { dateTime: localIso("2026-10-22", from) }, end: { dateTime: localIso("2026-10-22", to) } }, "hobbies");
  const c = conflicts([ev("Oskar: A", "14:15", "16:00", "Areena, Helsinki"), ev("Oliver: B", "15:45", "18:15", "Matinkylä 5, Espoo")]);
  assert.equal(c.length, 1);
});

test("one child booked in two places is a conflict; games count as coming up, practices don't", async () => {
  const { conflicts, isComingUp, toHubEvent } = await import("../src/digest/build.js");
  const ev = (summary: string, from: string, to: string, location: string) =>
    toHubEvent({ id: summary, summary, location, start: { dateTime: localIso("2026-10-25", from) }, end: { dateTime: localIso("2026-10-25", to) } }, "hobbies");
  const c = conflicts([ev("Oliver: PPJ Laru 2015", "13:30", "15:15", "Ruukinlahti, Espoo"), ev("Oliver: K-Espoo Blues 3 - Ice Force", "14:00", "16:30", "Matinkylä, Espoo")]);
  assert.equal(c.length, 1);
  assert.equal(conflicts([ev("Oliver: A", "13:30", "15:15", "Areena"), ev("Oliver: A", "13:30", "15:15", "Areena")]).length, 0);
  assert.ok(isComingUp("Oliver: K-Espoo Blues 3 - Ice Force"));
  assert.ok(isComingUp("Oskar: Talviliiga Ottelupäivä - Valkoinen"));
  assert.ok(isComingUp("Aino: Matematiikan koe"));
  assert.ok(isComingUp("Oliver: Harjoitusottelu K-Espoo - Ice Force"));
  assert.ok(!isComingUp("Oliver: K-E Blues 15: Jäävuoro"));
  assert.ok(!isComingUp("Oskar: Taitokoulu 2017 -syntyneet"));
  assert.ok(!isComingUp("Oliver: Lokakuun tiedote 2026 - alustava"));
  assert.ok(!isComingUp("Oliver: Kiekko-Espoo harjoitus"));
  // A group after the dash is a practice, not two teams (Henri, 2026-10-26).
  assert.ok(!isComingUp("Oskar: Futsal - Sininen"));
  assert.ok(!isComingUp("Oskar: PPJ Laru 2017 - Ryhmä Litmanen"));
});

test("changes since yesterday: coming days only, no bulletin dates, one line per event, Finnish dates", async () => {
  const { digestChanges, whenLabel, labels } = await import("../src/digest/build.js");
  const cfg = testConfig();
  const now = new Date("2026-10-26T04:45:00Z"); // Mon 06:45 Helsinki
  const at = "2026-10-25T20:27:00Z";
  const ch = digestChanges(
    [
      { at, source: "myclub", kind: "cancelled", title: "Oliver: PPJ Laru 2015: Treenit", when: "2026-10-25 13:30" }, // yesterday
      { at, source: "wilma", kind: "changed", title: "Oliver & Oskar: Lokakuun tiedote 2026 (from bulletin)", when: "2026-10-30" },
      { at, source: "wilma", kind: "changed", title: "Oliver: Uskonto Kirkkohistoria jakso 1", when: "2026-11-02" },
      { at, source: "wilma", kind: "changed", title: "Oliver: Uskonto koe (Kirkkohistoria jakso 1)", when: "2026-11-02" }, // renamed: last wins
      { at, source: "myclub", kind: "cancelled", title: "Oskar: Futis", when: "2026-10-28 17:00" },
      { at, source: "myclub", kind: "changed", title: "Oskar: Futis", when: "2026-11-20 17:00" }, // beyond the horizon
      { at: "2026-10-24T20:00:00Z", source: "myclub", kind: "cancelled", title: "Oskar: Vanha", when: "2026-10-27 17:00" }, // older than a day
    ],
    now,
    cfg,
  );
  assert.deepEqual(ch.map((c) => c.title), ["Oliver: Uskonto koe (Kirkkohistoria jakso 1)", "Oskar: Futis"]);
  const fi = labels({ ...cfg, digest: { ...cfg.digest, language: "fi" } });
  assert.equal(whenLabel("2026-10-28 17:00", fi), "ke 28.10. klo 17.00");
  assert.equal(whenLabel("2026-11-02", fi), "ma 2.11.");
});
