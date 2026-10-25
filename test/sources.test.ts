import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { testConfig } from "./config.js";
import { emptyState } from "../src/lib/state.js";
import { FixtureMyClub, feesDue, myclubEvents, openSignups, parseFeeds } from "../src/sources/myclub.js";
import { FixtureMail, assertNoSend, billsToRemind, detectInvoice, scanInvoices } from "../src/sources/outlook.js";
import { FixtureWilma, datesInText, needsAction, switchWilmaAccount, wilmaDiff, wilmaEvents } from "../src/sources/wilma.js";

const cfg = testConfig();
const FIX = fileURLToPath(new URL("./fixtures/", import.meta.url));
const today = "2026-10-21";

test("Wilma: exams become timed or all-day events titled with the child's first name", async () => {
  const snap = await new FixtureWilma(`${FIX}wilma.json`).fetch(cfg);
  const evs = wilmaEvents(snap, cfg, today);
  const math = evs.find((e) => e.sourceId === "exam:1001:501")!;
  assert.equal(math.title, "Aino: Matematiikka koe: chapters 3-4");
  assert.equal(math.description, "Kokeen lisätiedot: kpl 4-8 s. 16-36\nOpettaja: Satu Pietinen");
  snap.students[0].exams[0] = { ...snap.students[0].exams[0], subject: "Evankelisluterilainen uskonto", name: "Kirkkohistoria jakso 1", topic: null };
  assert.equal(wilmaEvents(snap, cfg, today).find((e) => e.sourceId === "exam:1001:501")!.title, "Aino: Evankelisluterilainen uskonto koe (Kirkkohistoria jakso 1)");
  assert.deepEqual(math.start, { dateTime: "2026-10-23T08:15:00+03:00", timeZone: "Europe/Helsinki" });
  const bio = evs.find((e) => e.sourceId === "exam:1001:502")!;
  assert.deepEqual(bio.start, { date: "2026-11-04" });
});

test("Wilma: dated bulletins become one tentative event even when two children see them", async () => {
  const snap = await new FixtureWilma(`${FIX}wilma.json`).fetch(cfg);
  const evs = wilmaEvents(snap, cfg, today).filter((e) => e.sourceId.startsWith("news:"));
  const parents = evs.filter((e) => e.sourceId.startsWith("news:7002"));
  assert.equal(parents.length, 1);
  assert.equal(parents[0].title, "Aino & Eero: Vanhempainilta (from bulletin)");
  assert.equal(parents[0].tentative, true);
  assert.deepEqual(parents[0].start, { dateTime: "2026-11-06T18:00:00+02:00", timeZone: "Europe/Helsinki" });
  assert.deepEqual(parents[0].end, { dateTime: "2026-11-06T19:30:00+02:00", timeZone: "Europe/Helsinki" });
});

test("Wilma: date reading from Finnish text", () => {
  assert.deepEqual(datesInText("Retki ke 12.11. klo 9.30", today), [{ date: "2026-11-12", start: "09:30", end: undefined }]);
  assert.deepEqual(datesInText("Joulujuhla 19.12.2026", today), [{ date: "2026-12-19", start: undefined, end: undefined }]);
  assert.deepEqual(datesInText("Talviloma 16.1.", today), [{ date: "2027-01-16", start: undefined, end: undefined }]);
  assert.deepEqual(datesInText("Viime viikolla 1.10.2026", today), []);
  assert.deepEqual(datesInText("klo 8.30.", today), []);
});

test("Wilma: action words", () => {
  assert.ok(needsAction("Palauttakaa allekirjoitettu lupalappu"));
  assert.ok(needsAction("Please sign the form"));
  assert.ok(!needsAction("Tervetuloa retkelle"));
});

test("Wilma: first run learns silently, later runs report only new items", async () => {
  const st = emptyState();
  const snap = await new FixtureWilma(`${FIX}wilma.json`).fetch(cfg);
  assert.equal(wilmaDiff(snap, st, cfg, today).fresh.length, 0);
  snap.students[0].messages.push({ id: 9003, subject: "Maksu retkestä 5 €", sentAt: "2026-10-21T05:00:00Z" });
  snap.students[1].notes.push({ date: "2026-10-21", subject: "Matematiikka", type: "Poissa" });
  snap.students[0].exams.push({ id: 503, date: "2026-10-22", subject: "Kemia", name: "Koe" });
  const d = wilmaDiff(snap, st, cfg, today);
  assert.equal(d.fresh.length, 2);
  assert.ok(d.fresh.find((f) => f.kind === "message")!.action);
  assert.equal(d.fresh.find((f) => f.kind === "note")!.text, "Poissa, Matematiikka (2026-10-21)");
  assert.deepEqual(d.examAlerts, ["Aino: Kemia exam added for 2026-10-22"]);
  assert.equal(wilmaDiff(snap, st, cfg, today).fresh.length, 0);
});

test("MyClub: events in window, cancelled marked, sign-ups and fees", async () => {
  const snap = await new FixtureMyClub(`${FIX}myclub.json`).fetch(cfg);
  const evs = myclubEvents(snap, cfg, new Date("2026-10-21T04:00:00Z"));
  assert.equal(evs.length, 4);
  assert.equal(evs.find((e) => e.sourceId === "mc-103")!.title, "CANCELLED: Aino: Uintiharjoitus");
  assert.equal(evs.find((e) => e.sourceId === "mc-100")!.title, "Eero: Jalkapallo harjoitus");
  const t = evs.find((e) => e.sourceId === "mc-102")!;
  assert.ok(t.reminderMinutes! > 0);
  assert.equal(openSignups(snap, today).length, 1);
  assert.deepEqual(feesDue(snap, today).map((f) => f.id), ["inv-1"]);
  assert.deepEqual(parseFeeds("Aino|https://a.ics\nhttps://b.ics"), [{ child: "Aino", url: "https://a.ics" }, { url: "https://b.ics" }]);
});

test("Outlook: finds Finnish and English bills, ignores newsletters and personal mail", async () => {
  const mail = new FixtureMail(`${FIX}outlook.json`);
  const msgs = await mail.listSince();
  const helen = detectInvoice(msgs[0])!;
  assert.equal(helen.amount, "64,20 €");
  assert.equal(helen.dueDate, "2026-10-24");
  assert.equal(helen.reference, "12345 67890");
  const stream = detectInvoice(msgs[1])!;
  assert.equal(stream.amount, "12.99 €");
  assert.equal(stream.dueDate, "2026-11-15");
  assert.equal(stream.reference, "RF71 4400 0011");
  assert.equal(detectInvoice(msgs[2]), null);
  assert.equal(detectInvoice(msgs[3]), null);
});

test("Outlook: scan flags bills once; reminders 3 days before and on the due date; new biller warning", async () => {
  const st = emptyState();
  const mail = new FixtureMail(`${FIX}outlook.json`);
  const r1 = await scanInvoices(mail, st, 14, new Date("2026-10-21T03:20:00Z"));
  assert.equal(r1.newBills.length, 2);
  assert.deepEqual(mail.flagged, ["m1", "m2"]);
  assert.ok(!r1.newBills[0].newBiller, "first scan does not flag every biller as new");
  const r2 = await scanInvoices(mail, st, 14, new Date("2026-10-22T03:20:00Z"));
  assert.equal(r2.newBills.length, 0);
  assert.deepEqual(billsToRemind(st, "2026-10-21", 3).map((b) => b.inDays), [3]);
  assert.deepEqual(billsToRemind(st, "2026-10-24", 3).map((b) => b.inDays), [0]);
  assert.deepEqual(billsToRemind(st, "2026-11-01", 3), []);
});

test("Outlook: nothing can be sent", () => {
  for (const p of ["/me/sendMail", "/me/messages/abc/send", "/me/messages/abc/reply", "/me/messages/abc/replyAll", "/me/messages/abc/forward"])
    assert.throws(() => assertNoSend("POST", p), /would send mail/);
  assert.doesNotThrow(() => assertNoSend("POST", "/me/messages/abc/createReply"));
  assert.doesNotThrow(() => assertNoSend("GET", "/me/mailFolders/inbox/messages?$top=50"));
});

test("Wilma mail rule is created once, with move + mark read, never forward", async () => {
  const { FixtureMail, ensureWilmaRule } = await import("../src/sources/outlook.js");
  const mail = new FixtureMail("test/fixtures/outlook.json");
  const created: unknown[] = [];
  const orig = mail.createRule.bind(mail);
  mail.createRule = async (r: unknown) => (created.push(r), orig(r));
  assert.equal(await ensureWilmaRule(mail, "Wilma", ["inschool.fi"]), "created");
  assert.equal(await ensureWilmaRule(mail, "Wilma", ["inschool.fi"]), "exists");
  assert.equal(created.length, 1);
  const actions = (created[0] as { actions: Record<string, unknown> }).actions;
  assert.deepEqual(Object.keys(actions).sort(), ["markAsRead", "moveToFolder", "stopProcessingRules"]);
});

test("Wilma: a new login account forgets the old session and learns silently again", async () => {
  const st = emptyState();
  assert.equal(switchWilmaAccount(st, "https://helsinki.inschool.fi", "henri"), false);
  const snap = await new FixtureWilma(`${FIX}wilma.json`).fetch(cfg);
  wilmaDiff(snap, st, cfg, today);
  st.wilma.session = "old";
  assert.equal(switchWilmaAccount(st, "https://helsinki.inschool.fi", "Henri"), false);
  assert.equal(st.wilma.session, "old");
  assert.equal(switchWilmaAccount(st, "https://helsinki.inschool.fi", "anna"), true);
  assert.equal(st.wilma.session, undefined);
  assert.equal(st.wilma.seenMessages.length, 0);
  snap.students[1].messages.push({ id: 9100, subject: "Vanha viesti", sentAt: "2026-10-01T05:00:00Z" });
  assert.equal(wilmaDiff(snap, st, cfg, today).fresh.length, 0);
});
