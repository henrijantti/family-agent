import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { handle, Tool } from "../src/agent/mcp.js";
import { familyTools } from "../src/agent/family-tools.js";
import { mailTools, type MailToolApi } from "../src/agent/mail-tools.js";
import { deskTools, deskWorkerTools } from "../src/agent/desk.js";
import { inviteIcs, inviteMime, inviteWhen } from "../src/agent/invite.js";
import { FakeCalendar } from "../src/calendar/fake.js";
import { emptyState } from "../src/lib/state.js";
import { testConfig } from "./config.js";

const NOW = new Date("2026-10-26T10:00:00Z");
const WORK = "henri@work.example";

async function call(tools: Tool[], name: string, args: object) {
  const res = (await handle("t", tools, { id: 1, method: "tools/call", params: { name, arguments: args } })) as any;
  const text = res.result?.content?.[0]?.text ?? res.error?.message;
  return { error: !!res.result?.isError || !!res.error, text: text as string, json: () => JSON.parse(text) };
}

test("invitation .ics: a timed event in UTC, escaped text, CRLF and folded lines", () => {
  const ics = inviteIcs(
    { title: "Oskar: vanhempainilta; luokka 3, sali", start: "2026-11-04T18:00:00+02:00", end: "2026-11-04T19:00:00+02:00", allDay: false, location: "Koulu" },
    "t20261026-abcdef@family-agent",
    "henri@outlook.example",
    WORK,
    NOW,
  );
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /\r\nMETHOD:REQUEST\r\n/);
  assert.match(ics, /\r\nDTSTART:20261104T160000Z\r\nDTEND:20261104T170000Z\r\n/);
  assert.match(ics, /SUMMARY:Oskar: vanhempainilta\\; luokka 3\\, sali\r\n/);
  assert.match(ics, /ORGANIZER:mailto:henri@outlook.example/);
  assert.match(ics.replace(/\r\n /g, ""), /ATTENDEE;[^\r]*:mailto:henri@work.example/);
  assert.ok(ics.split("\r\n").every((l) => Buffer.byteLength(l) <= 75));
  assert.equal(inviteWhen({ title: "", start: "2026-11-04T18:00:00+02:00", end: "2026-11-04T19:00:00+02:00", allDay: false }), "ke 4.11. klo 18.00–19.00");
});

test("invitation .ics: an all-day event keeps its dates", () => {
  const ics = inviteIcs({ title: "Syysloma", start: "2026-10-19", end: "2026-10-24", allDay: true }, "u", "a@x.example", WORK, NOW);
  assert.match(ics, /DTSTART;VALUE=DATE:20261019\r\nDTEND;VALUE=DATE:20261024\r\n/);
  assert.match(ics, /TRANSP:TRANSPARENT/);
  const m = inviteMime({ title: "Syysloma", start: "2026-10-19", end: "2026-10-24", allDay: true }, "u", "a@x.example", WORK, NOW);
  assert.match(m.mime, /^From: a@x.example\r\nTo: henri@work.example\r\n/);
  assert.match(m.mime, /Content-Type: text\/calendar; charset=UTF-8; method=REQUEST/);
  assert.equal(m.subject, "Kutsu: Syysloma");
});

test("work invitation: queued from the family tools, drafted from code, sent only to the work address on Henri's Allow", async () => {
  process.env.GOOGLE_FAMILY_CALENDAR_ID = "family";
  process.env.GOOGLE_SCHOOL_CALENDAR_ID = "school";
  process.env.GOOGLE_HOBBIES_CALENDAR_ID = "hobbies";
  const dir = mkdtempSync(join(tmpdir(), "invite-"));
  const deskFile = join(dir, "mail-desk.jsonl");
  const cal = new FakeCalendar();
  cal.seed("family", [
    { id: "ev1", summary: "Oskar: vanhempainilta", start: { dateTime: "2026-11-04T18:00:00+02:00" }, end: { dateTime: "2026-11-04T19:00:00+02:00" }, location: "Koulu" },
    { id: "ev2", summary: "Oskar: vanhempainilta", start: { dateTime: "2026-11-04T18:00:00+02:00" }, end: { dateTime: "2026-11-04T20:00:00+02:00" }, location: "Sali" },
  ]);
  let woke = 0;
  const fam = familyTools({ cfg: testConfig(), calendar: cal, loadState: () => emptyState(), now: () => NOW, group: true, workInvite: { deskFile, wake: () => woke++ } });
  assert.ok(!familyTools({ cfg: testConfig(), calendar: cal, loadState: () => emptyState(), now: () => NOW }).some((t) => t.name === "work_calendar_invite"));

  assert.match((await call(fam, "work_calendar_invite", { calendar: "family", id: "nope" })).text, /no upcoming event nope/);
  const q = (await call(fam, "work_calendar_invite", { calendar: "family", id: "ev1" })).json();
  assert.match(q.status, /Allow/);
  assert.equal((await call(fam, "work_calendar_invite", { calendar: "family", id: "ev1" })).json().taskId, q.taskId, "asking twice queues one invitation");
  assert.equal(woke, 1);
  // Same title and time, another event: its own invitation.
  const q2 = (await call(fam, "work_calendar_invite", { calendar: "family", id: "ev2" })).json();
  assert.notEqual(q2.taskId, q.taskId);
  // The Chief of staff can't make one itself.
  assert.match((await call(deskTools({ file: deskFile, now: () => NOW }), "desk_task_create", { kind: "work_invite" })).text, /must be one of/);

  const mimes: string[] = [];
  const sent: string[] = [];
  let draftTo = WORK;
  const api = {
    getMessage: async (id: string) => ({ id, subject: "Kutsu: Oskar: vanhempainilta", receivedDateTime: "", isDraft: true, toRecipients: [{ emailAddress: { address: draftTo } }] }),
    createMimeDraft: async (mime: string) => (mimes.push(mime), { id: "DRAFTinvite0001" }),
    sendDraft: async (id: string) => void sent.push(id),
  } as unknown as MailToolApi;
  const files = { draftsFile: join(dir, "mail-drafts.jsonl"), approvalsFile: join(dir, "mail-approvals.jsonl") };
  const mail = [
    ...mailTools({ mail: api, ...files, self: ["henri@outlook.example"], now: () => NOW, approvalWaitMs: 0, workInvite: { to: WORK, deskFile } }),
    ...deskWorkerTools({ file: deskFile, now: () => NOW, getMessage: (id) => api.getMessage(id), draftsFile: files.draftsFile }),
  ];
  const tasks = (await call(mail, "desk_tasks", {})).json();
  assert.equal(tasks[0].kind, "work_invite");
  assert.equal(tasks[0].invite.title, "Oskar: vanhempainilta");

  const d = (await call(mail, "mail_work_invite", { taskId: q.taskId })).json();
  assert.deepEqual([d.draftId, d.to, d.sent], ["DRAFTinvite0001", WORK, false]);
  assert.match(mimes[0], /To: henri@work.example/);
  assert.equal((await call(mail, "mail_work_invite", { taskId: q.taskId })).json().draftId, d.draftId, "no second draft");
  assert.equal(mimes.length, 1);

  assert.match((await call(mail, "mail_send", { draftId: d.draftId })).text, /not approved/);
  appendFileSync(files.approvalsFile, JSON.stringify({ draftId: d.draftId, decision: "allow-once", at: NOW.toISOString() }) + "\n");
  draftTo = "someone@else.example";
  assert.match((await call(mail, "mail_send", { draftId: d.draftId })).text, /must go only to henri@work.example/);
  draftTo = WORK;
  assert.equal((await call(mail, "mail_send", { draftId: d.draftId })).json().sent, true);
  assert.deepEqual(sent, [d.draftId]);
  // A run cut off before its report gets the sent invitation back, not a second one.
  assert.equal((await call(mail, "mail_work_invite", { taskId: q.taskId })).json().sent, true);
  assert.equal(mimes.length, 1);
  assert.match((await call(mail, "desk_report", { taskId: q.taskId, status: "done", items: [{ draftId: d.draftId }] })).text, /Reported 1/);
  assert.deepEqual((await call(mail, "desk_tasks", {})).json().map((t: any) => t.taskId), [q2.taskId]);

  // A mail server without the work address can't send an invitation draft, whatever the record says.
  const noWork = mailTools({ mail: api, ...files, self: ["henri@outlook.example"], now: () => NOW, approvalWaitMs: 0 });
  appendFileSync(files.draftsFile, JSON.stringify({ draftId: "DRAFTinvite0002", messageId: "invite:x", replyTo: WORK, subject: "", preview: "", at: NOW.toISOString(), kind: "invite" }) + "\n");
  appendFileSync(files.approvalsFile, JSON.stringify({ draftId: "DRAFTinvite0002", decision: "allow-once", at: NOW.toISOString() }) + "\n");
  assert.match((await call(noWork, "mail_send", { draftId: "DRAFTinvite0002" })).text, /only to Henri's work address/);
  assert.ok(!noWork.some((t) => t.name === "mail_work_invite"));
});
