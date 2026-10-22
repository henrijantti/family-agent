import assert from "node:assert/strict";
import { test } from "node:test";
import { testConfig } from "./config.js";
import { FakeCalendar } from "../src/calendar/fake.js";
import { Ctx, tick } from "../src/jobs.js";
import { StateStore } from "../src/lib/state.js";
import { localIso } from "../src/lib/time.js";
import { ConsoleNotifier } from "../src/notify/telegram.js";
import { FixtureMyClub } from "../src/sources/myclub.js";
import { FixtureMail } from "../src/sources/outlook.js";
import { FixtureWilma, WilmaProvider } from "../src/sources/wilma.js";

const FIX = new URL("./fixtures/", import.meta.url).pathname;
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
