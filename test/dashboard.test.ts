import assert from "node:assert/strict";
import { test } from "node:test";
import { testConfig } from "./config.js";
import { FakeCalendar } from "../src/calendar/fake.js";
import { dashboardModel, renderDashboard } from "../src/dashboard/build.js";
import { runDashboard } from "../src/dashboard/run.js";
import type { HubEvent } from "../src/digest/build.js";
import type { Ctx } from "../src/jobs.js";
import { emptyState } from "../src/lib/state.js";
import { addDays, fromLocal, localIso } from "../src/lib/time.js";
import { ConsoleNotifier } from "../src/notify/telegram.js";

Object.assign(process.env, {
  GOOGLE_FAMILY_CALENDAR_ID: "family",
  GOOGLE_SCHOOL_CALENDAR_ID: "school",
  GOOGLE_HOBBIES_CALENDAR_ID: "hobbies",
  TELEGRAM_FAMILY_CHAT_ID: "fam",
});

const TODAY = "2026-10-26"; // Monday
function ev(calendar: HubEvent["calendar"], title: string, day: number, start?: string, end?: string, location?: string): HubEvent {
  const date = addDays(TODAY, day);
  return { calendar, title, date, start, end, startMs: fromLocal(date, start ?? "00:00").getTime(), endMs: fromLocal(date, end ?? "23:59").getTime(), location, tentative: false };
}

const events = [
  ev("school", "Oskar: Retki (from bulletin)", 0),
  ev("hobbies", "Oliver: K-E Blues 15: Jäävuoro", 0, "07:00", "08:15", "Espoo Metro Areena, Urheilupuistontie 3"),
  ev("hobbies", "Oskar: PPJ: Harjoitukset", 0, "17:00", "18:00", "Leppävaaran stadion"),
  ev("hobbies", "Oliver: PPJ: Harjoitukset", 0, "17:30", "19:00", "Kilonkenttä"),
  ev("school", "Oliver: Matematiikan koe", 2, "08:15", "09:30"),
  ev("hobbies", "CANCELLED: Oskar: PPJ: Harjoitukset", 3, "17:00", "18:00"),
  ev("hobbies", "Oliver: Next week", 8, "17:00", "18:00"),
];

test("dashboard model: today first, next timed event, notices, kids", () => {
  const cfg = testConfig();
  const m = dashboardModel({ now: fromLocal(TODAY, "10:00"), cfg, events, health: {} });
  assert.equal(m.week, 44);
  assert.equal(m.todayEvents.length, 4);
  assert.equal(m.todayEvents[0].what, "Retki (tiedote)", "Finnish titles, no English markers");
  assert.ok(m.todayEvents.find((e) => e.start === "07:00")!.past);
  assert.equal(m.todayEvents.find((e) => e.start === "07:00")!.place, "Espoo Metro Areena");
  // Overlap 17:30-18:00 in different places, and the exam later in the week.
  assert.deepEqual(m.notices.map((n) => n.pill), ["Päällekkäin", "Koe"]);
  assert.match(m.notices[0].text, /^ma 26\.10\. 17:30–18:00 Oskar ja Oliver, kuka vie\?$/);
  assert.equal(m.days.length, 6);
  assert.ok(!m.days.flatMap((d) => d.events).some((e) => e.what === "Next week"), "only 7 days");
  const [oliver, oskar] = m.kids;
  assert.equal(oliver.count, 3);
  assert.equal(oliver.next?.start, "17:30");
  assert.equal(oskar.count, 2, "cancelled events don't count");
  assert.equal(oskar.next?.start, "17:00", "a timed event beats an all-day one for 'next'");
});

test("dashboard page: Kunto look, inlined font, a failed source in red, no bills", () => {
  const cfg = testConfig();
  const m = dashboardModel({ now: fromLocal(TODAY, "17:10"), cfg, events, health: { Wilma: { ok: false, at: "", error: "x" } } });
  const html = renderDashboard(m, cfg, "ma 17:10");
  assert.match(html, /@font-face\{font-family:Manrope;[^}]*base64,/);
  assert.match(html, /--primary:#5a5ad6/);
  assert.match(html, /<h1>Maanantai 26\.10\.<\/h1>/);
  assert.match(html, /4 menoa tänään/);
  assert.match(html, /Seuraavaksi <b>17:30<\/b> Oliver · PPJ: Harjoitukset/);
  assert.match(html, /PPJ: Harjoitukset <span class="pill accent">Käynnissä<\/span>/, "Oskar's 17:00 is on now");
  assert.match(html, /class="pill critical">Ei yhteyttä<\/span><span>Wilma ei vastannut/);
  assert.doesNotMatch(html, /https?:\/\//, "loads nothing from the network");
  assert.doesNotMatch(html, /lasku|€/i);
});

function ctx(now: string): { c: Ctx; notifier: ConsoleNotifier } {
  const cal = new FakeCalendar();
  cal.seed("hobbies", [
    { id: "a", summary: "Oliver: PPJ: Harjoitukset", start: { dateTime: localIso(TODAY, "17:30") }, end: { dateTime: localIso(TODAY, "19:00") }, location: "Kilonkenttä" },
  ]);
  const notifier = new ConsoleNotifier(false);
  return { c: { cfg: testConfig(), state: emptyState(), now: new Date(now), calendar: cal, notifier, log: () => {} }, notifier };
}

test("runDashboard: sends and pins once, then edits only when the content changes", async () => {
  const { c, notifier } = ctx(localIso(TODAY, "10:00"));
  let shots = 0;
  const shoot = async () => Buffer.from(`png${++shots}`);
  assert.equal(await runDashboard(c, { shoot }), "sent");
  assert.equal(notifier.photos.length, 1);
  assert.ok(notifier.photos[0].pinned);
  assert.match(notifier.photos[0].caption, /päivitetty ma 10:00/);
  const id = c.state.dashboard!.messageId;
  // Fifteen minutes later nothing changed: no picture, no edit.
  c.now = new Date(localIso(TODAY, "10:15"));
  assert.equal(await runDashboard(c, { shoot }), "unchanged");
  assert.equal(shots, 1);
  // A new event: the same pinned message is edited.
  await c.calendar!.insert("family", { id: "b", summary: "Anna: Jooga", start: { dateTime: localIso(addDays(TODAY, 1), "19:00") }, end: { dateTime: localIso(addDays(TODAY, 1), "20:00") } });
  assert.equal(await runDashboard(c, { shoot }), "edited");
  assert.equal(notifier.photos.length, 1);
  assert.equal(notifier.photos[0].edits, 1);
  assert.equal(c.state.dashboard!.messageId, id);
  // Someone deleted the message: a new one is sent and pinned.
  notifier.photos.length = 0;
  assert.equal(await runDashboard(c, { shoot, force: true }), "sent");
  assert.notEqual(c.state.dashboard!.messageId, undefined);
  assert.ok(notifier.photos[0].pinned);
});

test("runDashboard: a failed pin is retried on later runs until it works", async () => {
  const { c, notifier } = ctx(localIso(TODAY, "10:00"));
  let allowed = false;
  const realPin = notifier.pin.bind(notifier);
  notifier.pin = async (chat, id) => {
    if (!allowed) throw new Error("Telegram pinChatMessage: Bad Request: not enough rights to manage pinned messages in the chat");
    return realPin(chat, id);
  };
  const shoot = async () => Buffer.from("png");
  assert.equal(await runDashboard(c, { shoot }), "sent");
  assert.equal(c.state.dashboard!.pinned, false);
  assert.equal(await runDashboard(c, { shoot }), "unchanged");
  assert.equal(c.state.dashboard!.pinned, false);
  allowed = true; // Henri gave the bot "Pin messages"
  assert.equal(await runDashboard(c, { shoot }), "unchanged");
  assert.equal(c.state.dashboard!.pinned, true);
  assert.ok(notifier.photos[0].pinned);
});
