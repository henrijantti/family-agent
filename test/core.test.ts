import assert from "node:assert/strict";
import { test } from "node:test";
import { decrypt, emptyState, encrypt } from "../src/lib/state.js";
import { addDays, fromLocal, localIso, localParts } from "../src/lib/time.js";
import { totp } from "../src/lib/totp.js";
import { parseIcs } from "../src/lib/ics.js";
import { dueJobs } from "../src/jobs.js";
import { testConfig } from "./config.js";

test("Helsinki times carry the right offset across the DST change (25 Oct 2026)", () => {
  assert.equal(localIso("2026-10-24", "08:00"), "2026-10-24T08:00:00+03:00");
  assert.equal(localIso("2026-10-26", "08:00"), "2026-10-26T08:00:00+02:00");
  assert.equal(fromLocal("2026-10-26", "06:45").toISOString(), "2026-10-26T04:45:00.000Z");
  assert.equal(localParts(new Date("2026-10-21T03:45:00Z")).time, "06:45");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
});

test("state encryption round-trips and is opaque", () => {
  const blob = encrypt(JSON.stringify(emptyState()), "k");
  assert.ok(blob.startsWith("FAENC1:"));
  assert.ok(!blob.includes("wilma"));
  assert.deepEqual(JSON.parse(decrypt(blob, "k")), emptyState());
  assert.throws(() => decrypt(blob, "wrong"));
});

test("TOTP matches the RFC 6238 test vector", () => {
  assert.equal(totp("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", 59_000), "287082");
});

test("ICS feed: TZID, UTC, all-day, cancelled, folded lines", () => {
  const ics = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    "UID:a1",
    "SUMMARY:Harjoitus\\, U12",
    "DTSTART;TZID=Europe/Helsinki:20261021T170000",
    "DTEND;TZID=Europe/Helsinki:20261021T183000",
    "LOCATION:Teko",
    " nurmi",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:a2",
    "SUMMARY:Turnaus",
    "DTSTART;VALUE=DATE:20261025",
    "DTEND;VALUE=DATE:20261026",
    "STATUS:CANCELLED",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:a3",
    "SUMMARY:UTC",
    "DTSTART:20261021T140000Z",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
  const [a, b, c] = parseIcs(ics);
  assert.equal(a.summary, "Harjoitus, U12");
  assert.equal(a.location, "Tekonurmi");
  assert.deepEqual(a.start, { dateTime: "2026-10-21T14:00:00.000Z" });
  assert.deepEqual(b.start, { date: "2026-10-25" });
  assert.equal(b.cancelled, true);
  assert.deepEqual(c.start, { dateTime: "2026-10-21T14:00:00.000Z" });
});

test("scheduler: digest due at 06:45 Helsinki in summer and winter time, only once", () => {
  const cfg = testConfig();
  const st = emptyState();
  const winter = dueJobs(cfg, st, new Date("2026-11-04T04:45:00Z")).map((j) => j.job); // Wed 06:45 UTC+2
  assert.deepEqual(winter.sort(), ["digest", "myclub", "outlook", "wilma"]);
  const summer = dueJobs(cfg, st, new Date("2026-10-21T03:45:00Z")).map((j) => j.job); // Wed 06:45 UTC+3
  assert.ok(summer.includes("digest"));
  // The other DST tick is an hour early: nothing due yet.
  assert.deepEqual(dueJobs(cfg, st, new Date("2026-11-04T03:45:00Z")), []);
  for (const j of dueJobs(cfg, st, new Date("2026-11-04T04:45:00Z"))) st.lastRun[`${j.job}@${j.slot!.time}`] = j.key;
  assert.deepEqual(dueJobs(cfg, st, new Date("2026-11-04T05:15:00Z")), []);
  // Sunday evening: Wilma, then the week-ahead.
  const sunday = dueJobs(cfg, st, new Date("2026-11-08T16:45:00Z"));
  assert.deepEqual(sunday.map((j) => j.job), ["wilma"]);
  for (const j of sunday) st.lastRun[`${j.job}@${j.slot!.time}`] = j.key;
  assert.deepEqual(dueJobs(cfg, st, new Date("2026-11-08T17:15:00Z")).map((j) => j.job), ["week-ahead", "attendance-poll"]);
  // Wilma never runs on Saturday.
  assert.ok(!dueJobs(cfg, st, new Date("2026-11-07T04:45:00Z")).some((j) => j.job === "wilma"));
});
