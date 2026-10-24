import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyPlan, looksOdd, makePlan, planReport, target, undoYear, type BacklogApi } from "../src/mail-backlog.js";
import type { MailRule } from "../src/agent/mail-tools.js";
import type { MailMessage } from "../src/sources/outlook.js";

const NOW = new Date("2026-10-24T12:00:00Z");
let n = 0;
const msg = (from: string, subject: string, extra: Partial<MailMessage> = {}): MailMessage => ({
  id: `id${++n}`,
  subject,
  from: { emailAddress: { address: from } },
  receivedDateTime: "2024-05-01T08:00:00Z",
  bodyPreview: "",
  ...extra,
});
const unsub = { internetMessageHeaders: [{ name: "List-Unsubscribe", value: "<mailto:x@y>" }] };

test("backlog target: people, bills, flagged, Tärkeä and club mail stay; bulk mail is sorted", () => {
  const rules: MailRule[] = [];
  assert.equal(target(msg("anna@gmail.com", "Lauantai?"), rules), "Inbox");
  assert.equal(target(msg("news@shop.fi", "Syystarjoukset", unsub), rules), "Uutiskirjeet");
  assert.equal(target(msg("no-reply@service.fi", "Salasanasi vaihdettiin", unsub), rules), "Ilmoitukset");
  assert.equal(target(msg("noreply@posti.fi", "Paketti saapui"), rules), "Ilmoitukset");
  assert.equal(target(msg("orders@verkkokauppa.com", "Tilausvahvistus 12345"), rules), "Kuitit");
  assert.equal(target(msg("news@shop.fi", "Syystarjoukset", { ...unsub, flag: { flagStatus: "flagged" } }), rules), "Inbox");
  assert.equal(target(msg("news@shop.fi", "Syystarjoukset", { ...unsub, categories: ["Tärkeä"] }), rules), "Inbox");
  assert.equal(target(msg("noreply@myclub.fi", "Tapahtuma", unsub), rules), "Inbox");
  assert.equal(target(msg("info@vero.fi", "Veropäätös", unsub), rules), "Inbox");
  assert.equal(target(msg("laskut@energia.fi", "Lasku", { bodyPreview: "Eräpäivä 1.6.2024 summa 45,00 €" }), rules), "Inbox");
  assert.equal(target(msg("noreply@inschool.fi", "Wilma"), rules, { skipDomains: ["inschool.fi"] }), "Inbox");
  assert.equal(target(msg("info@company.fi", "Hei"), rules), "Inbox");
  assert.equal(target(msg("noreply@utility.fi", "Lasku lokakuu"), rules), "Inbox", "possible bill, body not checked");
  assert.equal(target(msg("noreply@shop.fi", "Muistutus: maksamaton tilaus"), rules), "Inbox");
});

test("backlog target: Henri's learned rules win", () => {
  const at = NOW.toISOString();
  const rules: MailRule[] = [
    { sender: "news@shop.fi", action: "not_newsletter", at },
    { sender: "@club.fi", action: "folder", folder: "Harrastukset", at },
  ];
  assert.equal(target(msg("news@shop.fi", "Syystarjoukset", unsub), rules), "Inbox");
  assert.equal(target(msg("x@club.fi", "Kausi alkaa"), rules), "Harrastukset");
});

test("backlog plan: counts, top domains, odd-year guard, report has no subjects", () => {
  const msgs = [msg("anna@gmail.com", "Salainen aihe"), msg("news@shop.fi", "Tarjous", unsub), msg("news@shop.fi", "Tarjous 2", unsub)];
  const p = makePlan(2024, msgs, [], NOW);
  assert.deepEqual(p.counts, { Inbox: 1, Uutiskirjeet: 2 });
  assert.deepEqual(p.domains.Uutiskirjeet, [["shop.fi", 2]]);
  assert.equal(looksOdd(p), true);
  const r = planReport(p);
  assert.ok(r.includes("Uutiskirjeet: 2") && r.includes("Jää Saapuneisiin: 1") && !r.includes("Salainen"));
});

function fakeApi() {
  const moves: [string, string][] = [];
  const created: string[] = [];
  let fail = false;
  const api: BacklogApi = {
    listRange: async () => [],
    listFolders: async () => [{ id: "f-del", displayName: "Poistetut" }],
    createFolder: async (name) => (created.push(name), { id: `f-${name}` }),
    wellKnownFolderIds: async () => ({ inbox: "f-in", deleteditems: "f-del" }),
    moveMany: async (ops) => ops.map((o) => (fail ? { id: o.id, error: "500" } : (moves.push([o.id, o.folderId]), { id: o.id, newId: `new-${o.id}` }))),
  };
  return { api, moves, created, setFail: (v: boolean) => (fail = v) };
}

test("backlog apply: creates folders, logs every move, resumes without repeats, undo moves back", async () => {
  const dir = mkdtempSync(join(tmpdir(), "backlog-"));
  const log = join(dir, "moves.jsonl");
  const f = fakeApi();
  const p = { year: 2024, at: NOW.toISOString(), scanned: 3, counts: {}, domains: {}, items: [{ id: "a", to: "Uutiskirjeet" }, { id: "b", to: "Kuitit" }] };
  const r = await applyPlan(f.api, p, log, () => NOW, { delayMs: 0 });
  assert.deepEqual(r, { moved: 2, failed: 0, stopped: false, left: 0 });
  assert.deepEqual(f.created.sort(), ["Kuitit", "Uutiskirjeet"]);
  assert.equal(readFileSync(log, "utf8").trim().split("\n").length, 2);

  assert.equal((await applyPlan(f.api, p, log, () => NOW, { delayMs: 0 })).moved, 0, "a rerun skips logged moves");

  const u = await undoYear(f.api, 2024, log, join(dir, "undo.jsonl"), { delayMs: 0 });
  assert.deepEqual(u, { back: 2, of: 2 });
  assert.deepEqual(f.moves.slice(-2), [["new-a", "f-in"], ["new-b", "f-in"]]);
  assert.equal((await undoYear(f.api, 2024, log, join(dir, "undo.jsonl"), { delayMs: 0 })).of, 0, "undo is not repeated");
});

test("backlog apply: refuses Deleted Items and stops after repeated errors", async () => {
  const dir = mkdtempSync(join(tmpdir(), "backlog-"));
  const f = fakeApi();
  const del = { year: 2024, at: NOW.toISOString(), scanned: 1, counts: {}, domains: {}, items: [{ id: "a", to: "Poistetut" }] };
  await assert.rejects(applyPlan(f.api, del, join(dir, "m.jsonl"), () => NOW, { delayMs: 0 }), /refusing/);

  f.setFail(true);
  const items = Array.from({ length: 10 }, (_, i) => ({ id: `x${i}`, to: "Uutiskirjeet" }));
  const r = await applyPlan(f.api, { ...del, items }, join(dir, "m.jsonl"), () => NOW, { chunk: 2, delayMs: 0 });
  assert.deepEqual(r, { moved: 0, failed: 6, stopped: true, left: 4 });
});
