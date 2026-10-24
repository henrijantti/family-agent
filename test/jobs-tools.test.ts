import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { handle, Tool } from "../src/agent/mcp.js";
import { jobsTools } from "../src/agent/jobs-tools.js";
import type { AttendanceWriter } from "../src/attendance.js";
import type { Ctx } from "../src/jobs.js";
import { withLock } from "../src/lib/lock.js";
import { StateStore } from "../src/lib/state.js";
import type { MyClubSnapshot } from "../src/sources/myclub.js";
import { testConfig } from "./config.js";

const snap: MyClubSnapshot = {
  fetchedAt: "2026-10-25T03:15:00Z",
  route: "ics",
  invoices: [],
  warnings: [],
  events: [
    { id: "a1", child: "PPj", title: "Harjoitus", start: { dateTime: "2026-10-27T14:30:00Z" }, end: { dateTime: "2026-10-27T16:00:00Z" } },
    { id: "a2", child: "PPj", title: "Harjoitus", start: { dateTime: "2026-10-29T14:30:00Z" }, end: { dateTime: "2026-10-29T16:00:00Z" } },
    { id: "b1", child: "Oskar", title: "Futis", start: { dateTime: "2026-10-28T15:00:00Z" }, end: { dateTime: "2026-10-28T16:00:00Z" } },
  ],
};

async function call(tools: Tool[], name: string, args: object = {}) {
  const res = (await handle("t", tools, { id: 1, method: "tools/call", params: { name, arguments: args } })) as any;
  const text = res.result.content[0].text as string;
  return { error: !!res.result.isError, text, json: () => JSON.parse(text) };
}

function setup(agentJobs: string[], writer?: AttendanceWriter) {
  const dir = mkdtempSync(join(tmpdir(), "jobs-"));
  const statePath = join(dir, "state.json");
  const seed = new StateStore(statePath);
  seed.data.myclub.lastSnapshot = snap;
  seed.data.outlook.bills.push({ messageId: "m1", biller: "PPJ", sender: "a@ppj.fi", amount: "30,40 €", dueDate: "2026-10-27", subject: "Lasku", newBiller: false, foundAt: "" });
  seed.data.digestQueue = [{ child: "Oskar", kind: "note", text: "x", action: false }];
  seed.save();
  const cfg = testConfig();
  cfg.agent_jobs = agentJobs;
  let now = new Date("2026-10-25T17:00:00Z"); // Sun 19:00 Helsinki
  const tools = jobsTools({
    cfg,
    statePath,
    openState: () => new StateStore(statePath),
    makeCtx: (state, notifier): Ctx => ({ cfg, state, now, notifier, attendanceWriter: writer, log: () => {} }),
    now: () => now,
  });
  return { tools, statePath, read: () => JSON.parse(readFileSync(statePath, "utf8")), setNow: (d: Date) => (now = d) };
}

test("job tools refuse to run while the tick still owns the job", async () => {
  const { tools } = setup([]);
  for (const name of ["sync_myclub", "scan_bills", "attendance_week", "attendance_apply"]) {
    const r = await call(tools, name);
    assert.ok(r.error, name);
    assert.match(r.text, /agent_jobs/);
  }
  assert.ok((await call(tools, "digest_mark_sent", { kind: "daily" })).error);
});

test("digest_mark_sent marks today's bill reminders, clears the queue and saves", async () => {
  const { tools, read, setNow } = setup(["digest"]);
  setNow(new Date("2026-10-24T04:00:00Z"));
  const r = (await call(tools, "digest_mark_sent", { kind: "daily" })).json();
  assert.equal(r.marked, "daily");
  const st = read();
  assert.deepEqual(st.digestQueue, []);
  assert.equal(st.lastDigestAt, "2026-10-24T04:00:00.000Z");
  assert.equal(r.billsReminded, 1);
  assert.deepEqual(st.outlook.bills[0].remindedOn, ["2026-10-24"]);
  // The week summary belongs to week-ahead, not digest.
  assert.ok((await call(tools, "digest_mark_sent", { kind: "week" })).error);
});

test("attendance: week question, button answers, Monday apply uses only explicit answers", async () => {
  const calls: [string, string, boolean][] = [];
  const writer: AttendanceWriter = { live: true, set: async (o, child, go) => (calls.push([child, o.eventId, go]), go ? "signed up" : "declined") };
  const { tools, read, setNow } = setup(["attendance-poll", "attendance-apply"], writer);
  const week = (await call(tools, "attendance_week")).json();
  assert.deepEqual(week.Oliver.map((o: any) => o.eventId), ["a1", "a2"]);
  assert.equal(read().myclub.agentPoll.status, "open");

  assert.ok(!(await call(tools, "attendance_record", { child: "Oliver", eventId: "a1", going: false })).error);
  assert.ok(!(await call(tools, "attendance_record", { child: "Oliver", eventId: "a1", going: true })).error); // last press wins
  assert.ok(!(await call(tools, "attendance_record", { child: "Oliver", eventId: "a2", going: false })).error);
  const bad = await call(tools, "attendance_record", { child: "Oskar", eventId: "a1", going: true });
  assert.ok(bad.error);
  assert.match(bad.text, /not offered/);

  setNow(new Date("2026-10-26T04:15:00Z"));
  const r = (await call(tools, "attendance_apply")).json();
  assert.equal(r.applied, true);
  assert.equal(r.live, true);
  assert.deepEqual(calls, [["Oliver", "a1", true], ["Oliver", "a2", false]]);
  assert.deepEqual(r.unanswered, ["Oskar"]);
  const st = read();
  assert.deepEqual(st.myclub.declined, ["a2"]);
  assert.equal(st.myclub.agentPoll.status, "applied");

  // Applied once only, and late presses are refused.
  assert.equal((await call(tools, "attendance_apply")).json().applied, false);
  assert.ok((await call(tools, "attendance_record", { child: "Oliver", eventId: "a2", going: true })).error);
  assert.equal(calls.length, 2);
});

test("the state lock runs one writer at a time and takes over a stale lock", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lock-"));
  const path = join(dir, "state.json");
  const order: string[] = [];
  const slow = withLock(path, async () => {
    order.push("a start");
    await new Promise((r) => setTimeout(r, 700));
    order.push("a end");
  });
  await new Promise((r) => setTimeout(r, 50));
  await withLock(path, async () => order.push("b"));
  await slow;
  assert.deepEqual(order, ["a start", "a end", "b"]);
  assert.ok(!existsSync(`${path}.lock`));

  mkdirSync(`${path}.lock`);
  const old = new Date(Date.now() - 20 * 60_000);
  utimesSync(`${path}.lock`, old, old);
  assert.equal(await withLock(path, async () => "took over"), "took over");

  mkdirSync(`${path}.lock`);
  await assert.rejects(withLock(path, async () => 1, 600), /busy/);

  // First run: the state folder doesn't exist yet.
  assert.equal(await withLock(join(dir, "new", "state.json"), async () => "ok"), "ok");
});

test("the tick skips the jobs listed in agent_jobs", async () => {
  const { dueJobs } = await import("../src/jobs.js");
  const { emptyState } = await import("../src/lib/state.js");
  const cfg = testConfig();
  const sunEvening = new Date("2026-10-25T17:05:00Z");
  assert.ok(dueJobs(cfg, emptyState(), sunEvening).some((j) => j.job === "attendance-poll"));
  cfg.agent_jobs = ["attendance-poll"];
  assert.ok(!dueJobs(cfg, emptyState(), sunEvening).some((j) => j.job === "attendance-poll"));
});
