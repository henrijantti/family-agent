import assert from "node:assert/strict";
import { test } from "node:test";
import { testConfig } from "./config.js";
import { emptyState } from "../src/lib/state.js";
import { ConsoleNotifier } from "../src/notify/telegram.js";
import { runAttendanceApply, runAttendancePoll, weekEvents, type AttendanceWriter } from "../src/attendance.js";
import type { Ctx } from "../src/jobs.js";
import type { MyClubSnapshot } from "../src/sources/myclub.js";

const snap: MyClubSnapshot = {
  fetchedAt: "2026-10-25T03:15:00Z",
  route: "ics",
  invoices: [],
  warnings: [],
  events: [
    { id: "a1", child: "PPj", title: "Harjoitus", start: { dateTime: "2026-10-27T14:30:00Z" }, end: { dateTime: "2026-10-27T16:00:00Z" } },
    { id: "a2", child: "PPj", title: "Harjoitus", start: { dateTime: "2026-10-29T14:30:00Z" }, end: { dateTime: "2026-10-29T16:00:00Z" } },
    { id: "a3", child: "PPj", title: "Peruttu treeni", start: { dateTime: "2026-10-30T14:30:00Z" }, end: { dateTime: "2026-10-30T16:00:00Z" }, cancelled: true },
    { id: "a4", child: "PPj", title: "Too far", start: { dateTime: "2026-11-05T14:30:00Z" }, end: { dateTime: "2026-11-05T16:00:00Z" } },
    { id: "b1", child: "Oskar", title: "Futis", start: { dateTime: "2026-10-28T15:00:00Z" }, end: { dateTime: "2026-10-28T16:00:00Z" } },
  ],
};

function ctx(now: Date, notifier: ConsoleNotifier): Ctx {
  const state = emptyState();
  state.myclub.lastSnapshot = snap;
  process.env.TELEGRAM_FAMILY_CHAT_ID = "-1";
  return { cfg: testConfig(), state, now, notifier, log: () => {} };
}

test("next week's events per child: mapped names, no cancelled, 7-day window", () => {
  const ids = weekEvents(snap, testConfig(), "Oliver", new Date("2026-10-25T16:00:00Z")).map((e) => e.id);
  assert.deepEqual(ids, ["a1", "a2"]);
});

test("Sunday poll per child, Monday apply signs up ticked and declines the rest", async () => {
  const n = new ConsoleNotifier(false);
  const c = ctx(new Date("2026-10-25T17:00:00Z"), n); // Sun 19:00 Helsinki (UTC+2)
  await runAttendancePoll(c);
  assert.equal(n.polls.length, 2);
  assert.match(n.polls[0].question, /Oliver/);
  assert.equal(n.polls[0].options.at(-1), "None of these");
  n.polls[0].votes = [1, 0, 0]; // Oliver: first practice only; Oskar: nobody answered
  const calls: [string, boolean][] = [];
  const writer: AttendanceWriter = { live: true, set: async (id, attend) => (calls.push([id, attend]), attend ? "signed up" : "declined") };
  c.now = new Date("2026-10-26T04:15:00Z");
  await runAttendanceApply(c, writer);
  assert.deepEqual(calls, [["a1", true], ["a2", false]]);
  assert.deepEqual(c.state.myclub.declined, ["a2"]);
  assert.ok(n.polls.every((p) => p.closed));
  assert.match(n.sent.map((s) => s.html).join("\n"), /Nobody answered Oskar/);
  // Applying again does nothing.
  await runAttendanceApply(c, writer);
  assert.equal(calls.length, 2);
});

test("'None of these' alone declines everything; dry run says nothing was sent", async () => {
  const n = new ConsoleNotifier(false);
  const c = ctx(new Date("2026-10-25T17:00:00Z"), n);
  await runAttendancePoll(c);
  n.polls[0].votes = [0, 0, 1];
  await runAttendanceApply(c);
  const out = n.sent.map((s) => s.html).join("\n");
  assert.match(out, /would decline/);
  assert.match(out, /Not sent to MyClub yet/);
});

test("poll uses the 'not answered' feed when set, not the calendar snapshot", async () => {
  const n = new ConsoleNotifier(false);
  const c = ctx(new Date("2026-10-25T17:00:00Z"), n);
  c.myclubInvites = { fetch: async () => ({ ...snap, events: snap.events.filter((e) => e.id === "a2") }) };
  await runAttendancePoll(c);
  assert.equal(n.polls.length, 1);
  assert.equal(n.polls[0].options.length, 2); // a2 + "None of these"
});
