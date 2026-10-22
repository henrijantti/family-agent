import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, triage, triageReport, wantsFlag, type TriageApi } from "../src/outlook-triage.js";
import type { MailMessage } from "../src/sources/outlook.js";

const msg = (o: Omit<Partial<MailMessage>, "from"> & { from: string }): MailMessage => ({
  id: o.id ?? o.from,
  subject: o.subject ?? "Hei",
  receivedDateTime: "2026-10-20T08:00:00Z",
  bodyPreview: o.bodyPreview ?? "",
  ...o,
  from: { emailAddress: { name: o.from.split("@")[0], address: o.from } },
} as MailMessage);

test("classify: invoice, newsletter, important, other", () => {
  assert.equal(classify(msg({ from: "laskut@elenia.fi", subject: "Lasku", bodyPreview: "Eräpäivä 30.10.2026, yhteensä 54,20 €" })), "invoice");
  assert.equal(classify(msg({ from: "news@shop.fi", internetMessageHeaders: [{ name: "List-Unsubscribe", value: "<mailto:x>" }] })), "newsletter");
  assert.equal(classify(msg({ from: "noreply@brand.com", bodyPreview: "Click to unsubscribe" })), "newsletter");
  assert.equal(classify(msg({ from: "matti.virtanen@gmail.com", subject: "Lauantain peli" })), "important");
  assert.equal(classify(msg({ from: "asiakaspalvelu@kauppa.fi", subject: "Vs: tilaus 123" })), "important");
  assert.equal(classify(msg({ from: "noreply@vero.fi", subject: "Uusi viesti OmaVerossa" })), "important");
  assert.equal(classify(msg({ from: "orders@kauppa.fi", subject: "Tilausvahvistus" })), null);
  assert.equal(classify(msg({ from: "x@espoo.inschool.fi", subject: "Viesti" }), { skipDomains: ["inschool.fi"] }), null);
  // Receipts are already paid; club mail and notes to self are left alone.
  assert.equal(classify(msg({ from: "no_reply@email.apple.com", subject: "Your receipt from Apple.", bodyPreview: "Total 9,55 €" })), null);
  assert.equal(classify(msg({ from: "ppj.reply@myclub.fi", internetMessageHeaders: [{ name: "List-Unsubscribe", value: "x" }] })), null);
  assert.equal(classify(msg({ from: "henri.jantti@outlook.com" }), { self: ["henri.jantti@outlook.com"] }), null);
});

test("triage labels once and only flags invoices and important mail", async () => {
  const labels: { id: string; cats: string[]; flag: boolean }[] = [];
  const msgs = [
    msg({ id: "n1", from: "news@shop.fi", internetMessageHeaders: [{ name: "List-Unsubscribe", value: "x" }] }),
    msg({ id: "n2", from: "news@shop.fi", internetMessageHeaders: [{ name: "List-Unsubscribe", value: "x" }], categories: ["Peru tilaus?"] }),
    msg({ id: "p1", from: "anna@gmail.com", categories: ["Perhe"] }),
  ];
  const api: TriageApi = {
    listInbox: async () => msgs,
    labelMany: async (ops) => {
      for (const o of ops) labels.push({ id: o.id, cats: o.categories, flag: o.flag });
      return 0;
    },
    ensureCategories: async () => {},
    unflag: async () => {},
  };
  const r = await triage(api, "2026-01-01T00:00:00Z", { max: 100, apply: true, now: new Date("2026-10-22T12:00:00Z") });
  assert.equal(r.skipped, 1);
  assert.deepEqual(labels, [
    { id: "n1", cats: ["Peru tilaus?"], flag: false },
    { id: "p1", cats: ["Perhe", "Tärkeä"], flag: true },
  ]);
  assert.match(triageReport(r), /2\tnews\tnews@shop\.fi/);
  const dry: string[] = [];
  await triage({ ...api, labelMany: async (ops) => (dry.push(...ops.map((o) => o.id)), 0) }, "x", { max: 100, apply: false });
  assert.deepEqual(dry, []);
});

test("only open invoices and recent important mail get a follow-up flag", () => {
  const now = new Date("2026-10-22T12:00:00Z");
  const bill = (due: string) => msg({ from: "laskut@x.fi", subject: "Lasku", bodyPreview: `Eräpäivä ${due}, yhteensä 10,00 €` });
  assert.equal(wantsFlag("invoice", bill("30.10.2026"), now), true);
  assert.equal(wantsFlag("invoice", bill("1.8.2026"), now), false);
  assert.equal(wantsFlag("important", { ...msg({ from: "a@gmail.com" }), receivedDateTime: "2026-06-01T00:00:00Z" }, now), false);
  assert.equal(wantsFlag("newsletter", msg({ from: "n@x.fi" }), now), false);
});
