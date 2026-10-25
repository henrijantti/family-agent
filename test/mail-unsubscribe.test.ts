import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyPlan, checkUrl, isPrivateAddress, makePlan, method, planReport, unsubTargets } from "../src/mail-unsubscribe.js";
import type { MailMessage } from "../src/sources/outlook.js";

const NOW = new Date("2026-10-25T12:00:00Z");
let n = 0;
const h = (name: string, value: string) => ({ name, value });
const DKIM = h("Authentication-Results", "spf=pass smtp.mailfrom=news.example.com; dkim=pass header.d=example.com");
const ONECLICK = [h("List-Unsubscribe", "<mailto:u@example.com>, <https://u.example.com/x?t=1>"), h("List-Unsubscribe-Post", "List-Unsubscribe=One-Click"), DKIM];
const msg = (address: string, name: string, headers: { name: string; value: string }[], at = "2026-10-01T08:00:00Z"): MailMessage => ({
  id: `id${++n}`,
  subject: "Uutiset",
  from: { emailAddress: { address, name } },
  receivedDateTime: at,
  internetMessageHeaders: headers,
});

test("unsubscribe method: one-click needs https, the Post header and DKIM pass", () => {
  assert.deepEqual(unsubTargets("<mailto:a@b>, <https://x/y>"), ["mailto:a@b", "https://x/y"]);
  assert.deepEqual(method(msg("a@x", "A", ONECLICK)), { method: "oneclick", url: "https://u.example.com/x?t=1" });
  assert.equal(method(msg("a@x", "A", ONECLICK.slice(0, 2))).method, "mailto", "no DKIM pass");
  assert.equal(method(msg("a@x", "A", [ONECLICK[0], DKIM])).method, "mailto", "no one-click Post");
  assert.equal(method(msg("a@x", "A", [h("List-Unsubscribe", "<https://u/x>"), DKIM])).method, "link");
  assert.equal(method(msg("a@x", "A", [h("list-unsubscribe", "<http://u/x>"), h("List-Unsubscribe-Post", "List-Unsubscribe=One-Click"), DKIM])).method, "link", "http is never posted");
  assert.equal(method(msg("a@x", "A", [])).method, "none");
});

test("unsubscribe plan: names match sender name or address, newest email decides, misses are listed", () => {
  const msgs = [
    msg("news@cdg.com", "Car Dealership Guy", [h("List-Unsubscribe", "<mailto:u@cdg.com>")], "2026-09-01T00:00:00Z"),
    msg("news@cdg.com", "Car Dealership Guy", ONECLICK, "2026-10-20T00:00:00Z"),
    msg("hello@vinhgiang.com", "Vinh", [h("List-Unsubscribe", "<https://v/x>")]),
    msg("matt@aihero.dev", "Matt Pocock", ONECLICK),
  ];
  const p = makePlan(msgs, ["car dealership guy", "vinhgiang", "FLAIR"], "Uutiskirjeet", NOW);
  assert.deepEqual(
    p.items.map((i) => [i.address, i.method, i.count]),
    [
      ["news@cdg.com", "oneclick", 2],
      ["hello@vinhgiang.com", "link", 1],
    ],
  );
  assert.deepEqual(p.missing, ["FLAIR"]);
  assert.match(planReport(p), /perutaan automaattisesti \(1\)/);
  assert.match(planReport(p), /Ei löytynyt kansiosta: FLAIR/);
});

test("unsubscribe url check: only https to public hosts", async () => {
  const pub = async () => ["93.184.216.34"];
  assert.equal((await checkUrl("https://u.example.com/x", pub)).hostname, "u.example.com");
  await assert.rejects(checkUrl("http://u.example.com/x", pub));
  await assert.rejects(checkUrl("https://user:pw@u.example.com/x", pub));
  await assert.rejects(checkUrl("https://u.example.com:8443/x", pub));
  await assert.rejects(checkUrl("https://127.0.0.1/x", pub));
  await assert.rejects(checkUrl("https://localhost/x", pub));
  await assert.rejects(checkUrl("https://evil.example.com/x", async () => ["100.123.81.124"]), /private/);
  for (const ip of ["10.0.0.1", "192.168.1.1", "172.20.0.1", "169.254.169.254", "100.64.0.1", "::1", "fd7a:115c::1", "::ffff:127.0.0.1"]) assert.ok(isPrivateAddress(ip), ip);
  for (const ip of ["93.184.216.34", "100.128.0.1", "2606:2800::1"]) assert.ok(!isPrivateAddress(ip), ip);
});

test("unsubscribe apply: posts one-click items once, logs every try, leaves the rest", async () => {
  const msgs = [msg("a@a.com", "A", ONECLICK), msg("b@b.com", "B", ONECLICK), msg("c@c.com", "C", [h("List-Unsubscribe", "<mailto:u@c.com>")])];
  const p = makePlan(msgs, ["A", "B", "C"], "Uutiskirjeet", NOW);
  const log = join(mkdtempSync(join(tmpdir(), "unsub-")), "log.jsonl");
  const posted: string[] = [];
  const check = async (u: string) => new URL(u);
  let status = 200;
  const post = async (u: URL) => {
    posted.push(u.href);
    const s = status;
    status = 500;
    return s;
  };
  const r = await applyPlan(p, log, () => NOW, post, check);
  assert.deepEqual(r.map((x) => [x.address, x.ok]), [["a@a.com", true], ["b@b.com", false]]);
  assert.equal(posted.length, 2, "mailto is never sent");
  status = 204;
  const again = await applyPlan(p, log, () => NOW, post, check);
  assert.deepEqual(again.map((x) => [x.address, x.ok]), [["b@b.com", true]], "a logged success is not repeated");
  assert.equal(readFileSync(log, "utf8").trim().split("\n").length, 3);
});
