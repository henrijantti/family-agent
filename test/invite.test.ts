import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { handle, Tool } from "../src/agent/mcp.js";
import { familyTools } from "../src/agent/family-tools.js";
import { claim, discardDraft, mailTools, type MailToolApi } from "../src/agent/mail-tools.js";
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

test("work invitation: queued from the family tools, built by code, sent without Allow but only to the work address", async () => {
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
  assert.match(q.status, /queued/);
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

  // The draft was changed in Outlook to another address: nothing goes.
  draftTo = "someone@else.example";
  assert.match((await call(mail, "mail_work_invite", { taskId: q.taskId })).text, /must go only to henri@work.example/);
  assert.deepEqual(sent, []);
  // The work address changed since the draft was made: nothing goes to the old one.
  const moved = mailTools({ mail: api, ...files, self: ["henri@outlook.example"], now: () => NOW, workInvite: { to: "new@work.example", deskFile } });
  assert.match((await call(moved, "mail_work_invite", { taskId: q.taskId })).text, /earlier work address/);
  assert.deepEqual(sent, []);
  draftTo = WORK;
  const d = (await call(mail, "mail_work_invite", { taskId: q.taskId })).json();
  assert.deepEqual([d.draftId, d.to, d.sent], ["DRAFTinvite0001", WORK, true]);
  assert.match(mimes[0], /To: henri@work.example/);
  assert.equal(mimes.length, 1, "the retry reused the first draft");
  assert.deepEqual(sent, [d.draftId]);
  // A run cut off before its report gets the sent invitation back: no second send.
  assert.equal((await call(mail, "mail_work_invite", { taskId: q.taskId })).json().sent, true);
  assert.deepEqual(sent, [d.draftId]);
  // mail_send (the Allow path) never sends an invitation.
  assert.match((await call(mail, "mail_send", { draftId: d.draftId })).text, /already sent|sent by mail_work_invite/);
  assert.match((await call(mail, "desk_report", { taskId: q.taskId, status: "done", items: [{ draftId: d.draftId }] })).text, /Reported 1/);
  assert.deepEqual((await call(mail, "desk_tasks", {})).json().map((t: any) => t.taskId), [q2.taskId]);

  // Two runs at once for one task: one sends, the other is told to wait. One invitation goes.
  const both = await Promise.all([call(mail, "mail_work_invite", { taskId: q2.taskId }), call(mail, "mail_work_invite", { taskId: q2.taskId })]);
  assert.deepEqual(both.map((r) => r.error).sort(), [false, true]);
  assert.match(both.find((r) => r.error)!.text, /another run is sending/);
  assert.equal(sent.length, 2);
  // The claim is released: a later retry gets the sent invitation back.
  assert.equal((await call(mail, "mail_work_invite", { taskId: q2.taskId })).json().sent, true);
  assert.equal(sent.length, 2);

  // Without the work address set, or with sending off, there is no invitation tool.
  assert.ok(!mailTools({ mail: api, ...files, self: ["henri@outlook.example"], now: () => NOW }).some((t) => t.name === "mail_work_invite"));
  const noSend = { ...api, sendDraft: undefined } as unknown as MailToolApi;
  assert.ok(!mailTools({ mail: noSend, ...files, self: ["henri@outlook.example"], now: () => NOW, workInvite: { to: WORK, deskFile } }).some((t) => t.name === "mail_work_invite"));
});

test("invitation claim: held while its process lives however old, taken over from a dead one, released only by its owner", () => {
  const f = join(mkdtempSync(join(tmpdir(), "claim-")), "x.lock");
  const release = claim(f)!;
  assert.ok(release);
  utimesSync(f, new Date(0), new Date(0));
  assert.equal(claim(f), undefined, "a live run's claim never expires");
  release();
  assert.ok(!existsSync(f));

  // A crashed run: its process is gone.
  writeFileSync(f, "999999999 dead");
  const again = claim(f)!;
  assert.ok(again);
  assert.match(readFileSync(f, "utf8"), new RegExp(`^${process.pid} `));
  again();
  // A recovery in progress elsewhere: a dead claim is left to it.
  writeFileSync(f, "999999999 dead");
  writeFileSync(`${f}.recover`, "1 busy");
  assert.equal(claim(f), undefined);
  assert.equal(readFileSync(f, "utf8"), "999999999 dead");
  unlinkSync(`${f}.recover`);
  const third = claim(f)!;
  assert.ok(third);
  assert.ok(!existsSync(`${f}.recover`), "the recovery claim is released");
  // A release after someone else's claim replaced ours leaves theirs alone.
  writeFileSync(f, "1 other");
  third();
  assert.equal(readFileSync(f, "utf8"), "1 other");
});

test("discard a draft: only an unsent agent draft still in Drafts, moved to Deleted Items, then never sent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "discard-"));
  const draftsFile = join(dir, "mail-drafts.jsonl");
  const rec = { draftId: "DRAFTold00001", messageId: "invite:t20261026-aaaaaa", replyTo: WORK, subject: "Kutsu: X", preview: "", at: NOW.toISOString(), kind: "invite" };
  appendFileSync(draftsFile, JSON.stringify(rec) + "\n" + JSON.stringify({ ...rec, draftId: "DRAFTsent0001" }) + "\n" + JSON.stringify({ draftId: "DRAFTsent0001", sentAt: NOW.toISOString() }) + "\n");
  let folder = "DRAFTS";
  const moves: string[] = [];
  const mail = {
    getMessage: async (id: string) => ({ id, subject: "Kutsu: X", receivedDateTime: "", isDraft: true, parentFolderId: folder }),
    move: async (id: string, to: string) => void moves.push(`${id}->${to}`),
    wellKnownFolderIds: async () => ({ drafts: "DRAFTS", deleteditems: "TRASH" }),
  };
  await assert.rejects(discardDraft(mail, draftsFile, "DRAFTnone0001", NOW), /only drafts the agents made/);
  await assert.rejects(discardDraft(mail, draftsFile, "DRAFTsent0001", NOW), /was sent/);
  folder = "ARCHIVE";
  await assert.rejects(discardDraft(mail, draftsFile, "DRAFTold00001", NOW), /not in Drafts/);
  folder = "DRAFTS";
  assert.match(await discardDraft(mail, draftsFile, "DRAFTold00001", NOW), /Deleted Items/);
  assert.deepEqual(moves, ["DRAFTold00001->TRASH"]);
  await assert.rejects(discardDraft(mail, draftsFile, "DRAFTold00001", NOW), /already discarded/);
  const tools = mailTools({ mail: { ...mail, sendDraft: async () => {} } as unknown as MailToolApi, draftsFile, approvalsFile: join(dir, "a.jsonl"), self: ["a@x.example"], now: () => NOW });
  assert.match((await call(tools, "mail_send", { draftId: "DRAFTold00001" })).text, /invitations are sent by mail_work_invite|discarded/);
});

test("calendar invitation to other people: only the addresses Henri gave, a draft that goes only on his Allow", async () => {
  process.env.GOOGLE_FAMILY_CALENDAR_ID = "family";
  process.env.GOOGLE_SCHOOL_CALENDAR_ID = "school";
  process.env.GOOGLE_HOBBIES_CALENDAR_ID = "hobbies";
  const dir = mkdtempSync(join(tmpdir(), "calinvite-"));
  const deskFile = join(dir, "mail-desk.jsonl");
  const cal = new FakeCalendar();
  cal.seed("family", [{ id: "ev9", summary: "Mailapelit + Dinner", start: { dateTime: "2026-11-27T17:00:00+02:00" }, end: { dateTime: "2026-11-27T22:00:00+02:00" } }]);
  let woke = 0;
  const fam = familyTools({ cfg: testConfig(), calendar: cal, loadState: () => emptyState(), now: () => NOW, calendarInvite: { deskFile, wake: () => woke++ } });
  const ARTO = "arto.example@mail.example";
  assert.match((await call(fam, "calendar_invite", { calendar: "family", id: "ev9", attendees: [] })).text, /1 to 10/);
  assert.match((await call(fam, "calendar_invite", { calendar: "family", id: "ev9", attendees: ["Arto"] })).text, /not an email address: arto. Ask Henri/, "a name is never enough");
  const q = (await call(fam, "calendar_invite", { calendar: "family", id: "ev9", attendees: [ARTO.toUpperCase()] })).json();
  assert.match(q.status, /Allow/);
  assert.deepEqual(q.attendees, [ARTO]);
  assert.equal((await call(fam, "calendar_invite", { calendar: "family", id: "ev9", attendees: [ARTO] })).json().taskId, q.taskId, "asking twice queues one");
  assert.equal(woke, 1);

  const mimes: string[] = [];
  const sent: string[] = [];
  let draftTo = [ARTO];
  const api = {
    getMessage: async (id: string) => ({ id, subject: "Kutsu: Mailapelit + Dinner", receivedDateTime: "", isDraft: true, toRecipients: draftTo.map((address) => ({ emailAddress: { address } })) }),
    createMimeDraft: async (mime: string) => (mimes.push(mime), { id: `DRAFTcal000${mimes.length}` }),
    sendDraft: async (id: string) => void sent.push(id),
  } as unknown as MailToolApi;
  const files = { draftsFile: join(dir, "mail-drafts.jsonl"), approvalsFile: join(dir, "mail-approvals.jsonl") };
  const mail = [
    ...mailTools({ mail: api, ...files, self: ["henri@outlook.example"], now: () => NOW, approvalWaitMs: 0, calendarInvite: { deskFile } }),
    ...deskWorkerTools({ file: deskFile, now: () => NOW, getMessage: (id) => api.getMessage(id), draftsFile: files.draftsFile }),
  ];
  assert.ok(!mail.some((t) => t.name === "mail_contacts"), "no address lookup");
  const task = (await call(mail, "desk_tasks", {})).json()[0];
  assert.deepEqual([task.kind, task.attendees], ["calendar_invite", [ARTO]]);

  const d = (await call(mail, "mail_calendar_invite", { taskId: q.taskId })).json();
  assert.deepEqual([d.draftId, d.to, d.sent], ["DRAFTcal0001", [ARTO], false]);
  assert.match(mimes[0], new RegExp(`To: ${ARTO}`));
  assert.equal((await call(mail, "mail_calendar_invite", { taskId: q.taskId })).json().draftId, d.draftId, "the same draft again");
  assert.deepEqual(sent, [], "making the draft sends nothing");
  assert.match((await call(mail, "desk_report", { taskId: q.taskId, status: "done", items: [{ draftId: d.draftId }] })).text, /Reported 1/);

  // Henri says send in the mail bot chat: the draft is found, and goes only with his Allow.
  assert.deepEqual((await call(mail, "mail_drafts_waiting", {})).json().map((w: any) => [w.draftId, w.kind, w.to]), [[d.draftId, "calendar_invite", ARTO]]);
  assert.match((await call(mail, "mail_send", { draftId: d.draftId })).text, /not approved/);
  appendFileSync(files.approvalsFile, JSON.stringify({ draftId: d.draftId, decision: "allow-once", at: NOW.toISOString() }) + "\n");
  draftTo = [ARTO, "someone@else.example"];
  assert.match((await call(mail, "mail_send", { draftId: d.draftId })).text, /must go only to/);
  draftTo = [ARTO];
  assert.equal((await call(mail, "mail_send", { draftId: d.draftId })).json().sent, true);
  assert.deepEqual(sent, [d.draftId]);
  assert.deepEqual((await call(mail, "mail_drafts_waiting", {})).json(), []);
  assert.match((await call(mail, "mail_calendar_invite", { taskId: q.taskId })).text, /already sent/);

  // Henri's own address is the organizer, never an attendee.
  const q2 = (await call(fam, "calendar_invite", { calendar: "family", id: "ev9", attendees: ["henri@outlook.example"] })).json();
  assert.match((await call(mail, "mail_calendar_invite", { taskId: q2.taskId })).text, /organizer/);
});
