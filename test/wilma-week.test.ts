import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { testConfig } from "./config.js";
import { wilmaWeek } from "../src/digest/wilma-week.js";
import { Ctx, tick } from "../src/jobs.js";
import { emptyState } from "../src/lib/state.js";
import { ConsoleNotifier } from "../src/notify/telegram.js";
import { FixtureWilma, type WilmaSnapshot } from "../src/sources/wilma.js";

const FIX = fileURLToPath(new URL("./fixtures/", import.meta.url));
const snap = () => new FixtureWilma(`${FIX}wilma.json`).fetch(testConfig());

test("wilma week: per child, the week's items only, shared bulletin once", async () => {
  const [aino, eero, both] = wilmaWeek(await snap(), "2026-10-25");
  assert.match(aino, /Wilma, Aino<\/b>\nvk 43 · ma 19\.10\. – su 25\.10\./);
  // The permission slip asks for action; the September trip letter is older than a week.
  assert.match(aino, /⚠️ <b>Vaatii toimia<\/b>\n\n• ti 20\.10\. <b>Lupalappu palautettava perjantaihin mennessä<\/b>\n Opettaja Virtanen/);
  assert.ok(!aino.includes("Syysretki"));
  assert.match(aino, /📖 <b>Läksyt<\/b>\n\n• to 22\.10\. <b>Englanti<\/b>\n Workbook p\. 34-35/);
  // Lesson note: kind and subject only.
  assert.match(eero, /🏷 <b>Merkinnät<\/b>\n\n• ti 20\.10\. Unohtanut varusteet\n Liikunta/);
  assert.ok(!eero.includes("Vanhempainilta"));
  assert.match(both, /Wilma, Aino &amp; Eero/);
  assert.match(both, /📌 <b>Tiedotteet<\/b>\n\n• ti 20\.10\. <b>Vanhempainilta<\/b>/);
  assert.ok(!aino.includes("Vanhempainilta"));
});

test("wilma week: next week's exams, and a quiet week says so", async () => {
  const s = await snap();
  const [aino] = wilmaWeek(s, "2026-10-21");
  assert.match(aino, /📝 <b>Kokeet ensi viikolla<\/b>\n\n• pe 23\.10\. <b>Matematiikka<\/b>\n chapters 3-4/);
  assert.ok(!aino.includes("Biologia")); // 4.11. is further than a week
  const quiet: WilmaSnapshot = { ...s, students: [{ ...s.students[0], messages: [], news: [], homework: [], exams: [] }] };
  assert.deepEqual(wilmaWeek(quiet, "2026-12-06").slice(1), []);
  assert.match(wilmaWeek(quiet, "2026-12-06")[0], /Ei uutta Wilmassa tällä viikolla\./);
});

test("wilma week: Wilma text is escaped, never HTML", async () => {
  const s = await snap();
  s.students[0].messages = [{ id: 1, subject: "<a href=x>klikkaa</a>", sender: "<b>x</b>", sentAt: "2026-10-24T10:00:00Z" }];
  const [aino] = wilmaWeek(s, "2026-10-25");
  assert.ok(aino.includes("&lt;a href=x&gt;klikkaa&lt;/a&gt;"));
  assert.ok(!aino.includes("<a "));
});

test("sunday Wilma run sends the week summary to the family group, other runs don't", async () => {
  process.env.TELEGRAM_FAMILY_CHAT_ID = "fam";
  const notifier = new ConsoleNotifier(false);
  const opts: { bodyDays?: number }[] = [];
  const fixture = new FixtureWilma(`${FIX}wilma.json`);
  const c: Ctx = {
    cfg: testConfig(),
    state: emptyState(),
    now: new Date("2026-10-25T16:50:00Z"), // Sun 18:50 Helsinki
    wilma: { fetch: (cfg, st, o) => (opts.push(o ?? {}), fixture.fetch(cfg)) },
    notifier,
    log: () => {},
  };
  assert.deepEqual(await tick(c), ["wilma"]);
  assert.deepEqual(opts, [{ bodyDays: 7 }]);
  assert.equal(notifier.sent.length, 3);
  assert.ok(notifier.sent.every((m) => m.chatId === "fam" && m.html.startsWith("📚")));
  c.now = new Date("2026-10-27T10:05:00Z"); // Tue 12:05: alerts run, no summary
  notifier.sent = [];
  await tick(c);
  assert.ok(!notifier.sent.some((m) => m.html.startsWith("📚")));
});
