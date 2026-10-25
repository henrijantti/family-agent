import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeCalendar } from "../src/calendar/fake.js";
import { describeWhen, eventId, syncSource } from "../src/calendar/sync.js";
import type { DesiredEvent } from "../src/calendar/types.js";

const opts = {
  calendarId: "school",
  source: "wilma" as const,
  windowStart: "2026-10-21T00:00:00+03:00",
  windowEnd: "2026-12-31T00:00:00+02:00",
  missingRunsBeforeDelete: 2,
  maxDeletes: 5,
  now: new Date("2026-10-21T04:00:00Z"),
};

const ev = (id: string, date: string, title = `Aino: exam ${id}`): DesiredEvent => ({
  source: "wilma",
  sourceId: id,
  title,
  start: { date },
  end: { date },
});

test("creates once, then skips: running twice never duplicates", async () => {
  const cal = new FakeCalendar();
  const items = [ev("1", "2026-10-23"), ev("2", "2026-11-04")];
  const a = await syncSource(cal, items, opts);
  const b = await syncSource(cal, items, opts);
  assert.equal(a.created, 2);
  assert.equal(b.created, 0);
  assert.equal(b.unchanged, 2);
  assert.equal(cal.all("school").length, 2);
  assert.equal(cal.all("school")[0].id, eventId("wilma", "1"));
});

test("a moved item is updated in place and reported as changed", async () => {
  const cal = new FakeCalendar();
  await syncSource(cal, [ev("1", "2026-10-23")], opts);
  const r = await syncSource(cal, [ev("1", "2026-10-24")], opts);
  assert.equal(r.updated, 1);
  assert.equal(r.changes[0].kind, "changed");
  assert.equal(cal.all("school").length, 1);
  assert.deepEqual(cal.all("school")[0].start, { date: "2026-10-24" });
});

test("missing once is ignored, missing twice deletes and reports cancelled", async () => {
  const cal = new FakeCalendar();
  await syncSource(cal, [ev("1", "2026-10-23"), ev("2", "2026-10-24")], opts);
  const once = await syncSource(cal, [ev("1", "2026-10-23")], opts);
  assert.equal(once.deleted, 0);
  assert.equal(once.markedMissing, 1);
  // Reappearing resets the counter.
  await syncSource(cal, [ev("1", "2026-10-23"), ev("2", "2026-10-24")], opts);
  await syncSource(cal, [ev("1", "2026-10-23")], opts);
  const twice = await syncSource(cal, [ev("1", "2026-10-23")], opts);
  assert.equal(twice.deleted, 1);
  assert.equal(twice.changes[0].kind, "cancelled");
  assert.equal(cal.all("school").length, 1);
});

test("more than 5 deletes in one run stops and deletes nothing", async () => {
  const cal = new FakeCalendar();
  const many = Array.from({ length: 8 }, (_, i) => ev(String(i), "2026-10-30"));
  await syncSource(cal, many, opts);
  await syncSource(cal, [ev("0", "2026-10-30")], opts);
  const r = await syncSource(cal, [ev("0", "2026-10-30")], opts);
  assert.equal(r.deleted, 0);
  assert.equal(r.abortedDeletes, 7);
  assert.match(r.warnings[0], /limit 5/);
  assert.equal(cal.all("school").length, 8);
});

test("an empty read is treated as a failure, not as everything cancelled", async () => {
  const cal = new FakeCalendar();
  await syncSource(cal, [ev("1", "2026-10-23")], opts);
  await syncSource(cal, [], opts);
  const r = await syncSource(cal, [], opts);
  assert.equal(r.deleted, 0);
  assert.equal(r.warnings.length, 1);
});

test("events people made are never touched", async () => {
  const cal = new FakeCalendar();
  cal.seed("school", [{ id: "human1", summary: "Our own note", start: { date: "2026-10-23" }, end: { date: "2026-10-24" } }]);
  for (let i = 0; i < 3; i++) await syncSource(cal, [ev("1", "2026-10-23")], opts);
  assert.ok(cal.all("school").some((e) => e.id === "human1" && e.summary === "Our own note"));
  assert.ok(!cal.calls.some((c) => c.includes("human1")));
});

test("an item that comes back after deletion is restored (409 on insert)", async () => {
  const cal = new FakeCalendar();
  await syncSource(cal, [ev("1", "2026-10-23"), ev("2", "2026-10-24")], opts);
  await syncSource(cal, [ev("2", "2026-10-24")], opts);
  await syncSource(cal, [ev("2", "2026-10-24")], opts);
  const r = await syncSource(cal, [ev("1", "2026-10-23"), ev("2", "2026-10-24")], opts);
  assert.equal(r.updated, 1);
  assert.equal(cal.all("school").length, 2);
});

test("change times are shown in Helsinki time whatever offset Google returns", () => {
  // 13:30 Helsinki on 25.10.2026 (EET, +02:00), returned in a +01:00 calendar zone
  assert.equal(describeWhen({ dateTime: "2026-10-25T12:30:00+01:00" }), "2026-10-25 13:30");
  assert.equal(describeWhen({ dateTime: "2026-10-25T11:30:00Z" }), "2026-10-25 13:30");
  assert.equal(describeWhen({ date: "2026-10-25" }), "2026-10-25");
});
