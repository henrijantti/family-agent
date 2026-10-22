import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encrypt } from "../src/lib/state.js";
import { wilmaFetchDue } from "../src/jobs.js";
import { testConfig } from "./config.js";
import { SnapshotWilma } from "../src/sources/wilma.js";

test("laptop fetch is due ~20 min before each Wilma slot, once, in both DST offsets", () => {
  const cfg = testConfig();
  const lastRun: Record<string, string> = {};
  // Wed 06:10 Helsinki in summer (UTC+3) and winter (UTC+2)
  assert.equal(wilmaFetchDue(cfg, lastRun, new Date("2026-10-21T03:10:00Z")), "2026-10-21 06:30");
  assert.equal(wilmaFetchDue(cfg, lastRun, new Date("2026-11-04T04:10:00Z")), "2026-11-04 06:30");
  // An hour early (the other DST cron hour): nothing due.
  assert.equal(wilmaFetchDue(cfg, lastRun, new Date("2026-11-04T03:10:00Z")), undefined);
  lastRun["wilma-fetch@06:30"] = "2026-11-04 06:30";
  assert.equal(wilmaFetchDue(cfg, lastRun, new Date("2026-11-04T04:40:00Z")), undefined);
  // Sunday evening slot; nothing on Saturday.
  assert.equal(wilmaFetchDue(cfg, lastRun, new Date("2026-11-08T16:40:00Z")), "2026-11-08 18:45");
  assert.equal(wilmaFetchDue(cfg, lastRun, new Date("2026-11-07T04:10:00Z")), undefined);
});

test("snapshot reader decrypts, and refuses a missing or stale snapshot", async () => {
  const cfg = testConfig();
  const dir = mkdtempSync(join(tmpdir(), "fa-"));
  const path = join(dir, "snap.json");
  const now = new Date("2026-11-04T05:00:00Z");
  await assert.rejects(new SnapshotWilma(path, "k", now).fetch(cfg), /no Wilma update/);
  const snap = { fetchedAt: "2026-11-04T04:12:00Z", students: [{ name: "Test Child", lessons: [], exams: [], homework: [], messages: [], news: [], notes: [] }] };
  writeFileSync(path, encrypt(JSON.stringify(snap), "k"));
  const got = await new SnapshotWilma(path, "k", now).fetch(cfg);
  assert.equal(got.students.length, 1);
  await assert.rejects(new SnapshotWilma(path, "k", new Date("2026-11-04T09:00:00Z")).fetch(cfg), /5 h old/);
});
