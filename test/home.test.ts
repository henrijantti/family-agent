import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FakeCalendar } from "../src/calendar/fake.js";
import { handle, Tool } from "../src/agent/mcp.js";
import { addMonths, homeTools, inboundFile, sniff, stage } from "../src/agent/home.js";
import { CHAT_TAG } from "../src/agent/family-tools.js";
import { testConfig } from "./config.js";

async function call(tools: Tool[], name: string, args: object) {
  const res = (await handle("t", tools, { id: 1, method: "tools/call", params: { name, arguments: args } })) as any;
  const text = res.result.content[0].text as string;
  return { error: !!res.result.isError, text, json: () => JSON.parse(text) };
}

function setup(now = "2026-10-25T08:00:00Z") {
  process.env.GOOGLE_FAMILY_CALENDAR_ID = "family";
  process.env.GOOGLE_SCHOOL_CALENDAR_ID = "school";
  process.env.GOOGLE_HOBBIES_CALENDAR_ID = "hobbies";
  const dir = mkdtempSync(join(tmpdir(), "home-"));
  const media = join(dir, "inbound");
  mkdirSync(media);
  const cal = new FakeCalendar();
  const clock = { at: new Date(now) };
  const uploads: string[] = [];
  const drive = {
    async createFolder(name: string) {
      uploads.push(`folder ${name}`);
      return "folder1";
    },
    async upload(folder: string, name: string) {
      uploads.push(`${folder}/${name}`);
      return { id: "f1", link: "https://drive.google.com/file/d/f1/view" };
    },
  };
  const tools = homeTools({ cfg: testConfig(), calendar: cal, file: join(dir, "home.json"), mediaDir: media, drive, now: () => clock.at });
  return { dir, media, cal, clock, uploads, tools };
}

test("addMonths keeps the day, clamping to the month's end", () => {
  assert.equal(addMonths("2026-10-25", 12), "2027-10-25");
  assert.equal(addMonths("2026-01-31", 1), "2026-02-28");
  assert.equal(addMonths("2026-11-15", 6), "2027-05-15");
});

test("reminder stages: first notice, week, day before, the day, weekly when overdue", () => {
  assert.equal(stage(40, 30), undefined);
  assert.equal(stage(30, 30), "lead");
  assert.equal(stage(7, 30), "7");
  assert.equal(stage(5, 7), "lead");
  assert.equal(stage(1, 30), "1");
  assert.equal(stage(0, 30), "day");
  assert.equal(stage(-3, 30), "over0");
  assert.equal(stage(-8, 30), "over1");
});

test("reminder_add puts an all-day chat event on the Anna Henri calendar, once", async () => {
  const { cal, tools } = setup();
  const r = (await call(tools, "reminder_add", { kind: "upkeep", title: "Auto: katsastus", due: "2026-11-20", everyMonths: 12 })).json();
  assert.equal(r.remindDays, 30);
  assert.equal(r.repeats, "yearly");
  const evs = cal.all("family");
  assert.equal(evs.length, 1);
  assert.deepEqual(evs[0].start, { date: "2026-11-20" });
  assert.equal(evs[0].extendedProperties?.private?.agent, CHAT_TAG);
  const again = (await call(tools, "reminder_add", { kind: "upkeep", title: "Auto: katsastus", due: "2026-11-20" })).json();
  assert.equal(again.id, r.id);
  assert.equal(cal.all("family").length, 1);
  const off = (await call(tools, "reminder_add", { kind: "other", title: "Ei kalenteriin", due: "2026-11-21", calendar: false })).json();
  assert.equal(off.onCalendar, false);
});

test("a birthday given as the birth date moves to the next one, with the age", async () => {
  const { cal, tools } = setup();
  const r = (await call(tools, "reminder_add", { kind: "birthday", title: "Mummin syntymäpäivä", person: "Mummi", due: "1955-03-14", born: 1955 })).json();
  assert.equal(r.due, "2027-03-14");
  assert.equal(r.age, 72);
  assert.equal(r.remindDays, 14);
  assert.equal(cal.all("family")[0].summary, "Mummi: syntymäpäivä (72 v)");
});

test("reminders_due tells each stage once, and done moves a repeating one on", async () => {
  const { cal, clock, tools } = setup();
  const r = (await call(tools, "reminder_add", { kind: "upkeep", title: "Renkaanvaihto talvirenkaisiin", due: "2026-11-01", everyMonths: 6, remindDays: 14 })).json();
  const due = (await call(tools, "reminders_due", { mark: true })).json();
  assert.equal(due.length, 1);
  assert.equal(due[0].stage, "7");
  assert.equal((await call(tools, "reminders_due", { mark: true })).json().length, 0);
  // Without mark nothing is recorded.
  clock.at = new Date("2026-10-31T08:00:00Z");
  assert.equal((await call(tools, "reminders_due", {})).json()[0].stage, "1");
  assert.equal((await call(tools, "reminders_due", {})).json()[0].stage, "1");
  const done = (await call(tools, "reminder_done", { id: r.id })).json();
  assert.equal(done.status, "next");
  assert.equal(done.reminder.due, "2027-05-01");
  assert.deepEqual(cal.all("family")[0].start, { date: "2027-05-01" });
});

test("a one-off reminder is done for good; remove cancels its calendar event", async () => {
  const { cal, tools } = setup();
  const a = (await call(tools, "reminder_add", { kind: "document", title: "Oskar: passi vanhenee", due: "2027-01-10" })).json();
  assert.equal(a.remindDays, 60);
  assert.equal((await call(tools, "reminder_done", { id: a.id })).json().status, "done");
  assert.equal((await call(tools, "reminder_list", {})).json().length, 0);
  assert.equal((await call(tools, "reminder_list", { all: true })).json().length, 1);
  const b = (await call(tools, "reminder_add", { kind: "contract", title: "Sähkösopimus päättyy", due: "2027-02-01" })).json();
  await call(tools, "reminder_remove", { id: b.id });
  assert.equal(cal.all("family").length, 1);
  assert.match((await call(tools, "reminder_done", { id: b.id })).text, /no reminder/);
});

test("birthdays that passed move to next year by themselves", async () => {
  const { clock, tools } = setup();
  await call(tools, "reminder_add", { kind: "birthday", title: "Oskarin syntymäpäivä", person: "Oskar", due: "2026-11-02" });
  clock.at = new Date("2026-11-05T08:00:00Z");
  await call(tools, "reminders_due", { mark: true });
  assert.equal((await call(tools, "reminder_list", {})).json()[0].due, "2027-11-02");
});

test("paper_save keeps the file, uploads it to Drive and turns expires into a reminder", async () => {
  const { dir, media, cal, uploads, tools } = setup();
  writeFileSync(join(media, "kuitti---0b9d4c1e-1111-2222-3333-444455556666.pdf"), "%PDF-1.7 test");
  const res = (await call(tools, "paper_save", { media: "media://inbound/kuitti---0b9d4c1e-1111-2222-3333-444455556666.pdf", kind: "warranty", title: "Astianpesukone Gigantti", date: "2026-10-20", amount: "549,00 €", expires: "2028-10-20" })).json();
  assert.equal(res.status, "saved");
  assert.equal(res.drive, "saved");
  assert.deepEqual(uploads, ["folder Perheen paperit", "folder1/2026-10-20 Astianpesukone Gigantti.pdf"]);
  const saved = join(dir, res.paper.file);
  assert.equal(readFileSync(saved, "utf8"), "%PDF-1.7 test");
  assert.equal(statSync(saved).mode & 0o777, 0o600);
  const rem = (await call(tools, "reminder_list", {})).json();
  assert.equal(rem[0].title, "Astianpesukone Gigantti: takuu päättyy");
  assert.equal(rem[0].remindDays, 30);
  assert.equal(cal.all("family").length, 1);
  const again = (await call(tools, "paper_save", { media: "kuitti---0b9d4c1e-1111-2222-3333-444455556666.pdf", kind: "warranty", title: "x" })).json();
  assert.equal(again.status, "already saved");
  const found = (await call(tools, "paper_list", { query: "gigantti" })).json();
  assert.equal(found.length, 1);
  assert.equal(found[0].file, undefined);
});

test("paper_save without Drive keeps the copy on the server and says so", async () => {
  const { dir, media } = setup();
  const tools = homeTools({ cfg: testConfig(), file: join(dir, "home2.json"), mediaDir: media, now: () => new Date("2026-10-25T08:00:00Z") });
  writeFileSync(join(media, "a.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]));
  const res = (await call(tools, "paper_save", { media: "media://inbound/a.jpg", kind: "receipt", title: "Kuitti" })).json();
  assert.match(res.drive, /not signed in/);
  assert.match(res.paper.file, /^papers\/2026\/p[0-9a-f]+-kuitti\.jpg$/);
});

test("media references: only plain files in the inbound folder, only documents and photos", () => {
  const { media } = setup();
  writeFileSync(join(media, "ok.pdf"), "%PDF-");
  assert.ok(inboundFile(media, "media://inbound/ok.pdf").endsWith("ok.pdf"));
  for (const bad of ["../home.json", "media://inbound/../x", "/etc/passwd", "media/inbound/x/y.pdf", ".hidden"]) {
    assert.throws(() => inboundFile(media, bad), /media must be|no attachment/, bad);
  }
  symlinkSync("/etc/hostname", join(media, "link.pdf"));
  assert.throws(() => inboundFile(media, "link.pdf"), /not a regular file/);
  assert.throws(() => sniff(Buffer.from("#!/bin/sh")), /only PDFs and photos/);
  assert.equal(sniff(Buffer.from("%PDF-1.4")).ext, "pdf");
});

test("holiday_plan lists the next school holidays with the weekends and calendar events", async () => {
  const { cal, tools } = setup();
  cal.seed("hobbies", [
    { id: "t1", summary: "Oliver: turnaus", start: { dateTime: "2026-12-27T10:00:00+02:00" }, end: { dateTime: "2026-12-27T14:00:00+02:00" } },
  ]);
  const res = (await call(tools, "holiday_plan", { months: 5 })).json();
  assert.deepEqual(res.holidays.map((h: any) => h.name), ["Joululoma", "Talviloma"]);
  const xmas = res.holidays[0];
  assert.deepEqual(xmas.withWeekends, { from: "2026-12-19", to: "2027-01-06", days: 19 });
  assert.equal(xmas.events[0].title, "Oliver: turnaus");
  assert.ok(!xmas.freeDays.includes("2026-12-27"));
  assert.deepEqual(res.holidays[1].withWeekends, { from: "2027-02-20", to: "2027-02-28", days: 9 });
});

test("a snoozed reminder stays quiet, then is told once more", async () => {
  const { clock, tools } = setup();
  const r = (await call(tools, "reminder_add", { kind: "other", title: "Soita vakuutusyhtiöön", due: "2026-10-27" })).json();
  assert.equal((await call(tools, "reminders_due", { mark: true })).json().length, 1);
  await call(tools, "reminder_snooze", { id: r.id, days: 3 });
  clock.at = new Date("2026-10-27T08:00:00Z");
  assert.equal((await call(tools, "reminders_due", { mark: true })).json().length, 0);
  clock.at = new Date("2026-10-28T08:00:00Z");
  const again = (await call(tools, "reminders_due", { mark: true })).json();
  assert.equal(again[0].stage, "snoozed2026-10-28");
  assert.equal((await call(tools, "reminders_due", { mark: true })).json().length, 0);
  clock.at = new Date("2026-11-04T08:00:00Z");
  assert.equal((await call(tools, "reminders_due", { mark: true })).json()[0].stage, "over1");
});

test("review fixes: update keeps repeat bounds, multi-day events fill their days, local-only papers reach Drive later", async () => {
  const { dir, media, cal, tools } = setup();
  const r = (await call(tools, "reminder_add", { kind: "upkeep", title: "Auto: huolto", due: "2026-11-20", everyMonths: 12 })).json();
  assert.match((await call(tools, "reminder_update", { id: r.id, everyMonths: -1 })).text, /everyMonths must be 1-120/);
  cal.seed("family", [{ id: "trip", summary: "Matka: Levi", start: { date: "2026-12-18" }, end: { date: "2026-12-24" } }]);
  const xmas = (await call(tools, "holiday_plan", { months: 3 })).json().holidays[0];
  for (const day of ["2026-12-19", "2026-12-21", "2026-12-23"]) assert.ok(!xmas.freeDays.includes(day), day);
  assert.ok(xmas.freeDays.includes("2026-12-24"));
  // Saved without Drive, then uploaded once Drive is there.
  const file = join(dir, "home.json");
  const offline = homeTools({ cfg: testConfig(), file, mediaDir: media, now: () => new Date("2026-10-25T08:00:00Z") });
  writeFileSync(join(media, "b.pdf"), "%PDF-1.4 b");
  assert.match((await call(offline, "paper_save", { media: "b.pdf", kind: "receipt", title: "Kuitti B" })).json().drive, /not signed in/);
  const synced = (await call(tools, "paper_sync_drive", {})).json();
  assert.equal(synced.uploaded, 1);
  assert.equal((await call(tools, "paper_save", { media: "b.pdf", kind: "receipt", title: "x" })).json().drive, "saved");
});
