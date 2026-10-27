import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { handle, Tool } from "../src/agent/mcp.js";
import { groupReminderTools, sendGroupReminders } from "../src/agent/group-reminders.js";
import { ConsoleNotifier } from "../src/notify/telegram.js";

async function call(tools: Tool[], name: string, args: object) {
  const res = (await handle("t", tools, { id: 1, method: "tools/call", params: { name, arguments: args } })) as any;
  const text = res.result.content[0].text as string;
  return { error: !!res.result.isError, text, json: () => JSON.parse(text) };
}

function setup(now = "2026-10-27T12:00:00Z") {
  const file = join(mkdtempSync(join(tmpdir(), "grem-")), "group-reminders.json");
  const clock = { at: new Date(now) };
  return { file, clock, tools: groupReminderTools({ file, now: () => clock.at }) };
}

test("group_reminder_add queues once and checks the time", async () => {
  const { tools } = setup();
  const r = (await call(tools, "group_reminder_add", { date: "2026-10-29", time: "07:00", text: "Oskarin retkipäivä: eväät mukaan" })).json();
  assert.deepEqual([r.at, r.status], ["2026-10-29 07:00", "pending"]);
  assert.equal((await call(tools, "group_reminder_add", { date: "2026-10-29", time: "07:00", text: "Oskarin retkipäivä: eväät mukaan" })).json().existing, true);
  assert.match((await call(tools, "group_reminder_add", { date: "2026-10-29", time: "23:30", text: "x" })).text, /between 06:00 and 22:00/);
  assert.match((await call(tools, "group_reminder_add", { date: "2026-10-27", time: "08:00", text: "x" })).text, /already passed/);
  assert.match((await call(tools, "group_reminder_add", { date: "2026-02-31", time: "08:00", text: "x" })).text, /not a date/);
  assert.match((await call(tools, "group_reminder_add", { date: "2027-06-01", time: "08:00", text: "x" })).text, /at most 120 days/);
  assert.equal((await call(tools, "group_reminder_list", {})).json().length, 1);
});

test("the tick posts due reminders once, keeps future and cancelled ones, drops stale ones", async () => {
  const { file, clock, tools } = setup();
  const due = (await call(tools, "group_reminder_add", { date: "2026-10-29", time: "07:00", text: "Eväät <mukaan>" })).json();
  await call(tools, "group_reminder_add", { date: "2026-10-30", time: "07:00", text: "Huomenna" });
  const gone = (await call(tools, "group_reminder_add", { date: "2026-10-29", time: "06:30", text: "Peruttu" })).json();
  assert.equal((await call(tools, "group_reminder_cancel", { id: gone.id })).json().status, "cancelled");
  await call(tools, "group_reminder_add", { date: "2026-10-28", time: "08:00", text: "Myöhässä" });

  const tg = new ConsoleNotifier();
  const at = new Date("2026-10-29T05:10:00Z"); // 07:10 Helsinki
  assert.equal(await sendGroupReminders(file, tg, "group", at), 1);
  assert.deepEqual(tg.sent, [{ chatId: "group", html: "⏰ <b>Muistutus:</b> Eväät &lt;mukaan&gt;" }]);
  assert.equal(await sendGroupReminders(file, tg, "group", at), 0, "sent once");

  clock.at = at;
  const all = (await call(tools, "group_reminder_list", { all: true })).json();
  assert.deepEqual(
    all.map((r: any) => `${r.at} ${r.status}`),
    ["2026-10-28 08:00 missed", "2026-10-29 06:30 cancelled", "2026-10-29 07:00 sent", "2026-10-30 07:00 pending"],
  );
  assert.equal(all.find((r: any) => r.id === due.id).sentAt, at.toISOString());
});

test("a failed send stays waiting for the next tick", async () => {
  const { file, tools } = setup();
  await call(tools, "group_reminder_add", { date: "2026-10-29", time: "07:00", text: "A" });
  await call(tools, "group_reminder_add", { date: "2026-10-29", time: "07:05", text: "B" });
  let calls = 0;
  const flaky = { async send() { if (calls++ === 0) throw new Error("telegram down"); } };
  assert.equal(await sendGroupReminders(file, flaky as never, "group", new Date("2026-10-29T05:10:00Z")), 1);
  assert.equal(await sendGroupReminders(file, flaky as never, "group", new Date("2026-10-29T05:25:00Z")), 1, "A goes on the retry");
});

test("an overdue reminder never goes out at night: it waits for morning or drops", async () => {
  const { file, tools } = setup();
  await call(tools, "group_reminder_add", { date: "2026-10-29", time: "22:00", text: "Myöhäinen" });
  const tg = new ConsoleNotifier();
  assert.equal(await sendGroupReminders(file, tg, "group", new Date("2026-10-29T20:10:00Z")), 1, "22:10 is the tick after");
  await call(tools, "group_reminder_add", { date: "2026-10-30", time: "21:45", text: "Yö" });
  assert.equal(await sendGroupReminders(file, tg, "group", new Date("2026-10-30T22:00:00Z")), 0, "00:00 Helsinki: held");
  assert.equal(await sendGroupReminders(file, tg, "group", new Date("2026-10-31T04:00:00Z")), 0, "06:00 is over 6 h late: dropped");
  assert.equal((await call(tools, "group_reminder_list", { all: true })).json().find((r: any) => r.text === "Yö").status, "missed");
});
