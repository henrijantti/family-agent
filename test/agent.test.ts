import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FakeCalendar } from "../src/calendar/fake.js";
import { emptyState } from "../src/lib/state.js";
import { handle, Tool } from "../src/agent/mcp.js";
import { CHAT_TAG, eventTimes, familyTools, updatedTimes } from "../src/agent/family-tools.js";
import { BrainDeps, brainTools, lint, slugify } from "../src/agent/brain.js";
import { testConfig } from "./config.js";

const NOW = new Date("2026-10-23T15:00:00Z");

async function call(tools: Tool[], name: string, args: object) {
  const res = (await handle("t", tools, { id: 1, method: "tools/call", params: { name, arguments: args } })) as any;
  const text = res.result.content[0].text as string;
  return { error: !!res.result.isError, text, json: () => JSON.parse(text) };
}

function family() {
  process.env.GOOGLE_FAMILY_CALENDAR_ID = "family";
  process.env.GOOGLE_SCHOOL_CALENDAR_ID = "school";
  process.env.GOOGLE_HOBBIES_CALENDAR_ID = "hobbies";
  const cal = new FakeCalendar();
  cal.seed("hobbies", [
    {
      id: "synced1",
      summary: "Oliver: Kiekko-Espoo harjoitus",
      start: { dateTime: "2026-10-27T17:00:00+02:00" },
      end: { dateTime: "2026-10-27T18:00:00+02:00" },
      extendedProperties: { private: { agent: "family-agent", source: "myclub", sourceId: "x" } },
    },
  ]);
  const state = emptyState();
  state.outlook.bills.push(
    { messageId: "m1", biller: "PPJ", sender: "a@ppj.fi", amount: "30,40 €", dueDate: "2026-10-30", subject: "Lasku", newBiller: false, foundAt: "" },
    { messageId: "m2", biller: "Later", sender: "b@x.fi", dueDate: "2026-12-30", subject: "Lasku", newBiller: false, foundAt: "" },
  );
  return { cal, tools: familyTools({ cfg: testConfig(), calendar: cal, loadState: () => structuredClone(state), now: () => NOW }) };
}

test("MCP: initialize, tools/list, notifications get no reply, unknown method errors", async () => {
  const { tools } = family();
  const init = (await handle("t", tools, { id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })) as any;
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.equal(await handle("t", tools, { method: "notifications/initialized" }), undefined);
  const list = (await handle("t", tools, { id: 2, method: "tools/list" })) as any;
  assert.ok(list.result.tools.every((t: any) => t.inputSchema.additionalProperties === false));
  const bad = (await handle("t", tools, { id: 3, method: "nope" })) as any;
  assert.equal(bad.error.code, -32601);
});

test("MCP: arguments are validated, unknown keys refused", async () => {
  const { tools } = family();
  assert.match((await call(tools, "calendar_add", { calendar: "family", title: "x", date: "2026-10-28" })).text, /must be one of school, hobbies/);
  assert.match((await call(tools, "calendar_add", { calendar: "school", title: "x", date: "28.10." })).text, /wrong format/);
  assert.match((await call(tools, "calendar_add", { calendar: "school", title: "x", date: "2026-10-28", sudo: true })).text, /unknown argument sudo/);
  assert.match((await call(tools, "calendar_list", { from: "2026-01-01", to: "2026-12-31" })).text, /at most 62 days/);
});

test("event times: all-day, default one hour, past midnight, multi-day", () => {
  assert.deepEqual(eventTimes("2026-10-28"), { start: { date: "2026-10-28" }, end: { date: "2026-10-29" } });
  assert.equal((eventTimes("2026-10-28", "17:30").end as any).dateTime, "2026-10-28T18:30:00+02:00");
  assert.equal((eventTimes("2026-10-28", "23:00", "01:00").end as any).dateTime, "2026-10-29T01:00:00+02:00");
  assert.deepEqual(eventTimes("2026-10-28", undefined, undefined, "2026-10-30").end, { date: "2026-10-31" });
  // Default end past midnight lands on the next day.
  assert.equal((eventTimes("2026-10-28", "23:30").end as any).dateTime, "2026-10-29T00:30:00+02:00");
});

test("updates keep the fields not given: moving the date keeps the times, a new start keeps the duration", () => {
  const timed = { id: "e", start: { dateTime: "2026-10-28T09:00:00+02:00" }, end: { dateTime: "2026-10-28T14:00:00+02:00" } };
  const iso = (t: any) => [t.start.dateTime ?? t.start.date, t.end.dateTime ?? t.end.date];
  assert.deepEqual(iso(updatedTimes(timed, { date: "2026-10-30" })), ["2026-10-30T09:00:00+02:00", "2026-10-30T14:00:00+02:00"]);
  assert.deepEqual(iso(updatedTimes(timed, { start: "10:00" })), ["2026-10-28T10:00:00+02:00", "2026-10-28T15:00:00+02:00"]);
  assert.deepEqual(iso(updatedTimes(timed, { end: "16:00" })), ["2026-10-28T09:00:00+02:00", "2026-10-28T16:00:00+02:00"]);
  const allDay = { id: "a", start: { date: "2026-10-28" }, end: { date: "2026-10-30" } };
  assert.deepEqual(iso(updatedTimes(allDay, { date: "2026-11-02" })), ["2026-11-02", "2026-11-04"]);
});

test("calendar_add tags the event, skips a duplicate, and the chat can change and remove only its own events", async () => {
  const { cal, tools } = family();
  const added = (await call(tools, "calendar_add", { calendar: "school", title: "Oskar: retki", date: "2026-10-28", start: "09:00", end: "14:00" })).json();
  assert.equal(added.status, "added");
  const ev = cal.all("school").find((e) => e.id === added.id)!;
  assert.equal(ev.extendedProperties?.private?.agent, CHAT_TAG);
  assert.match(ev.id, /^[a-v0-9]{5,}$/);

  const again = (await call(tools, "calendar_add", { calendar: "school", title: "Oskar: retki", date: "2026-10-28", start: "09:00" })).json();
  assert.equal(again.status, "already there");
  assert.equal(cal.all("school").length, 1);

  const moved = (await call(tools, "calendar_update", { calendar: "school", id: added.id, start: "10:00" })).json();
  assert.equal(moved.start, "2026-10-28T10:00:00+02:00");
  assert.equal(cal.all("school")[0].summary, "Oskar: retki");

  const listed = (await call(tools, "calendar_list", { from: "2026-10-26", to: "2026-10-28" })).json();
  assert.deepEqual(
    listed.map((e: any) => [e.calendar, e.addedByChat]),
    [["hobbies", false], ["school", true]],
  );

  // A synced MyClub event is not the chat's to touch.
  assert.match((await call(tools, "calendar_update", { calendar: "hobbies", id: "synced1", title: "x" })).text, /no event synced1 that this chat added/);
  assert.match((await call(tools, "calendar_delete", { calendar: "hobbies", id: "synced1" })).text, /no event synced1/);
  assert.equal(cal.all("hobbies").length, 1);

  assert.equal((await call(tools, "calendar_delete", { calendar: "school", id: added.id })).json().status, "removed");
  assert.equal(cal.all("school").length, 0);
});

test("bills_list shows bills due within 14 days unless all is asked", async () => {
  const { tools } = family();
  const soon = (await call(tools, "bills_list", {})).json();
  assert.deepEqual(soon.map((b: any) => [b.biller, b.inDays]), [["PPJ", 7]]);
  assert.equal((await call(tools, "bills_list", { all: true })).json().length, 2);
});

test("week_overview renders without sending anything", async () => {
  const { tools } = family();
  const r = await call(tools, "week_overview", {});
  assert.equal(r.error, false);
  assert.match(r.text, /Kiekko-Espoo/);
  assert.doesNotMatch(r.text, /<b>/);
});

// ---------- Brain vault ----------

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
}

function vault(): BrainDeps & { remote: string } {
  const base = mkdtempSync(join(tmpdir(), "brain-test-"));
  const remote = join(base, "remote.git");
  const root = join(base, "vault");
  execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", remote]);
  mkdirSync(root);
  git(root, "init", "--quiet", "-b", "main");
  const files: Record<string, string> = {
    "AGENTS.md": "# rules\n",
    "index.md": "# Index\n- [[finish-things]] — finish (seed)\n- [[questions]] — queue\n- [[gone-page]] — missing\n",
    "log.md": "# log\n",
    "inbox/README.md": "drop here\n",
    "inbox/2026-10-01-old-idea.md": "# old idea\n",
    "raw/2026-07-23-src.md": "source\n",
    "wisdom/principles/finish-things.md":
      "---\ntype: principle\nstatus: seed\nreview_by: 2026-09-01\n---\n# Finish things\n\n## Evidence from my own life\nNone written yet.\n\n## Related\n[[be-kind]]\n",
    "wisdom/principles/be-kind.md": "---\ntype: principle\n---\n# Be kind\n\n## Evidence from my own life\nHelped a neighbour.\n\n## Related\n[[finish-things]]\n",
    "health/rollup.md": "# rollup\nweight 90 kg\n",
    "ai/questions.md": "# questions\n\n1. Attention & the KV cache — what is stored?\n2. Second one\n",
  };
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(root, p, ".."), { recursive: true });
    writeFileSync(join(root, p), c);
  }
  git(root, "add", "-A");
  git(root, "commit", "--quiet", "-m", "init");
  git(root, "remote", "add", "origin", remote);
  git(root, "push", "--quiet", "-u", "origin", "main");
  return { root, remote, exclude: ["health"], repoUrl: "https://github.com/henrijantti/Brain", now: () => NOW, push: true };
}

test("brain_capture writes one new inbox file, commits and pushes it to main", async () => {
  const d = vault();
  const tools = brainTools(d);
  const r = (await call(tools, "brain_capture", { title: "Pelaajien äänet\nline two", text: "Coach said X", url: "https://x.com/a/1" })).json();
  assert.equal(r.saved, "inbox/2026-10-23-pelaajien-aanet-line-two.md");
  const text = readFileSync(join(d.root, r.saved), "utf8");
  assert.match(text, /^# Pelaajien äänet line two\n\nhttps:\/\/x.com\/a\/1\n\nCoach said X/);
  assert.match(git(d.remote, "log", "-1", "--format=%s", "main"), /^capture: Pelaajien äänet line two/);
  // Same title again gets its own file, never overwrites.
  const r2 = (await call(tools, "brain_capture", { title: "Pelaajien äänet line two", text: "again\n\n\n\nkept" })).json();
  assert.equal(r2.saved, "inbox/2026-10-23-pelaajien-aanet-line-two-2.md");
  assert.match(readFileSync(join(d.root, r2.saved), "utf8"), /again\n\n\n\nkept\n/);
});

test("brain reads skip excluded folders; paths can't escape", async () => {
  const d = vault();
  const tools = brainTools(d);
  assert.match((await call(tools, "brain_read", { page: "finish-things" })).text, /^wisdom\/principles\/finish-things.md/);
  assert.match((await call(tools, "brain_read", { page: "health/rollup.md" })).text, /health\/ is off limits/);
  assert.match((await call(tools, "brain_read", { page: "rollup" })).text, /no page named rollup/);
  assert.match((await call(tools, "brain_read", { page: "../../etc/passwd" })).text, /leaves the vault/);
  assert.equal((await call(tools, "brain_search", { query: "90 kg" })).json().length, 0);
  assert.equal((await call(tools, "brain_search", { query: "neighbour" })).json()[0].page, "wisdom/principles/be-kind.md");
});

test("brain_propose puts the ingest on a review branch, never on main, and refuses protected paths", async () => {
  const d = vault();
  const tools = brainTools(d);
  const mainBefore = git(d.remote, "rev-parse", "main");
  for (const [path, why] of [
    ["AGENTS.md", /not a path an ingest may write/],
    ["health/protocols/sleep.md", /off limits/],
    ["raw/2026-07-23-src.md", /immutable/],
    ["templates/x.md", /not a path/],
    ["inbox/2026-10-01-old-idea.md", /not a path/],
  ] as const) {
    assert.match((await call(tools, "brain_propose", { title: "t", summary: "s", files: [{ path, content: "x" }] })).text, why);
  }
  const r = (
    await call(tools, "brain_propose", {
      title: "Old idea filed",
      summary: "new principle seed",
      files: [
        { path: "wisdom/principles/old-idea.md", content: "# Old idea" },
        { path: "index.md", content: "# Index\n- [[old-idea]]" },
      ],
      clearInbox: ["inbox/2026-10-01-old-idea.md"],
    })
  ).json();
  assert.equal(r.branch, "ingest/2026-10-23-old-idea-filed");
  assert.equal(r.review, "https://github.com/henrijantti/Brain/compare/main...ingest%2F2026-10-23-old-idea-filed?expand=1");
  assert.equal(git(d.remote, "rev-parse", "main"), mainBefore);
  const files = git(d.remote, "ls-tree", "-r", "--name-only", r.branch);
  assert.match(files, /wisdom\/principles\/old-idea.md/);
  assert.doesNotMatch(files, /inbox\/2026-10-01-old-idea.md/);
  // The local clone stays on main with the inbox item still there until Henri merges.
  assert.ok(existsSync(join(d.root, "inbox/2026-10-01-old-idea.md")));
  assert.equal(git(d.root, "branch", "--show-current").trim(), "main");
  // Same title again (or a retry) gets a new branch instead of failing.
  const again = (await call(tools, "brain_propose", { title: "Old idea filed", summary: "retry", files: [{ path: "wisdom/principles/old-idea.md", content: "# Old idea v2" }] })).json();
  assert.equal(again.branch, "ingest/2026-10-23-old-idea-filed-2");
});

test("brain lint finds drift, overdue reviews and principles without evidence", () => {
  const l = lint(vault());
  assert.equal(l.inbox, 1);
  assert.deepEqual(l.notInIndex, ["be-kind"]);
  assert.deepEqual(l.indexLinksWithoutPage, ["gone-page"]);
  assert.deepEqual(l.overdueReview, [{ page: "wisdom/principles/finish-things.md", review_by: "2026-09-01" }]);
  assert.deepEqual(l.principlesWithoutEvidence, ["finish-things"]);
  assert.equal(l.nextQuizQuestion, "Attention & the KV cache — what is stored?");
});

test("slugify keeps Finnish letters readable", () => {
  assert.equal(slugify("Äiti & Öljy: Åland!"), "aiti-oljy-aland");
  assert.equal(slugify("!!!"), "capture");
});
