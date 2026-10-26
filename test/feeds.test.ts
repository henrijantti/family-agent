import assert from "node:assert/strict";
import { test } from "node:test";
import { testConfig } from "./config.js";
import { FakeCalendar } from "../src/calendar/fake.js";
import { Ctx, dueJobs, runFeeds } from "../src/jobs.js";
import { StateStore } from "../src/lib/state.js";

const ICS = (games: string) => `BEGIN:VCALENDAR\r\nPRODID:TASO\r\nX-WR-CALNAME:PKT – M4DIV ES\r\n${games}END:VCALENDAR\r\n`;
const game = (uid: string, start: string, summary: string) =>
  `BEGIN:VEVENT\r\nUID:${uid}\r\nDTSTART:${start}\r\nDTEND:${start.replace(/T(\d\d)/, (_, h) => `T${String(Number(h) + 1).padStart(2, "0")}`)}\r\nSUMMARY:${summary}\r\nLOCATION:Esport Areena kenttä 4\\, Espoo\r\nURL:https://tulospalvelu.salibandy.fi/match/1\r\nEND:VEVENT\r\n`;

test("public feeds: PKT's games go to the family calendar as Henri's, only the feed's own events are touched", async () => {
  process.env.GOOGLE_FAMILY_CALENDAR_ID = "family";
  const cfg = testConfig();
  cfg.feeds = { runs: [{ days: ["mon"], time: "06:20" }], horizon_days: 180, list: [{ name: "PKT", who: "Henri", calendar: "family", url: "webcal://example.test/calendar/team/2602" }] };
  const cal = new FakeCalendar();
  cal.seed("family", [{ id: "h1", summary: "Henri: dentist", start: { date: "2026-11-08" }, end: { date: "2026-11-09" } }]);
  let body = ICS(game("m1", "20261108T130000Z", "Flames - PKT") + game("m0", "20261020T130000Z", "Old - PKT"));
  const realFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (u: string) => (urls.push(u), new Response(body))) as typeof fetch;
  try {
    const state = new StateStore("/nonexistent/state.json").data;
    const ctx: Ctx = { cfg, state, now: new Date("2026-10-26T04:20:00Z"), calendar: cal, log: () => {} };
    assert.ok(dueJobs(cfg, state, ctx.now).some((j) => j.job === "feeds"));
    await runFeeds(ctx);
    assert.deepEqual(urls, ["https://example.test/calendar/team/2602"]);
    const all = cal.all("family");
    assert.equal(all.length, 2); // the dentist stays, the past game isn't added
    const g = all.find((e) => e.summary === "Henri: Flames - PKT")!;
    assert.equal(g.location, "Esport Areena kenttä 4, Espoo");
    assert.equal(state.health.Feeds.ok, true);

    // A failed read changes nothing and shows as a failing source.
    body = "<html>maintenance</html>";
    await runFeeds(ctx);
    assert.equal(cal.all("family").length, 2);
    assert.equal(state.health.Feeds.ok, false);
  } finally {
    globalThis.fetch = realFetch;
  }
});
