import { test } from "node:test";
import assert from "node:assert/strict";
import { handleUpdates, offerReplies, wantsReply, type AssistantConfig, type AssistantCtx, type ReplyWriter } from "../src/mail-assistant.js";
import { emptyState } from "../src/lib/state.js";
import { assertNoSend, type MailMessage } from "../src/sources/outlook.js";
import type { Button, Notifier, Update } from "../src/notify/telegram.js";
import { testConfig } from "./config.js";

const cfg = testConfig();

const HENRI = "111";
const msg = (o: Omit<Partial<MailMessage>, "from"> & { from: string }): MailMessage =>
  ({
    id: o.id ?? o.from,
    subject: o.subject ?? "Hei",
    receivedDateTime: "2026-10-22T08:00:00Z",
    bodyPreview: o.bodyPreview ?? "",
    ...o,
    from: { emailAddress: { name: o.from.split("@")[0], address: o.from } },
  }) as MailMessage;

const acfg = (o: Partial<AssistantConfig> = {}): AssistantConfig => ({
  enabled: true,
  send: false,
  writer: "claude",
  model: "test",
  max_per_run: 5,
  lookback_days: 3,
  self: ["henri@outlook.com"],
  signature: "Henri",
  ...o,
});

class FakeBot implements Notifier {
  sent: { html: string; buttons: Button[] }[] = [];
  answers: string[] = [];
  edits: string[] = [];
  queue: Update[] = [];
  async send() {}
  async sendButtons(_c: string, html: string, buttons: Button[]) {
    this.sent.push({ html, buttons });
    return 100 + this.sent.length;
  }
  async updates() {
    const q = this.queue;
    this.queue = [];
    return q;
  }
  async answerButton(_id: string, text: string) {
    this.answers.push(text);
  }
  async edit(_c: string, _m: number, html: string) {
    this.edits.push(html);
  }
}

function setup(o: Partial<AssistantConfig> = {}, inbox: MailMessage[] = []) {
  const sentDrafts: string[] = [];
  const drafts: { messageId: string; text: string }[] = [];
  const bot = new FakeBot();
  const writer: ReplyWriter = { write: async (m) => ({ needsReply: !m.subject.includes("FYI"), summary: "Kysyy aikaa", reply: `Vastaus: ${m.subject}` }) };
  const ctx: AssistantCtx = {
    cfg: { ...cfg, outlook: { ...cfg.outlook, assistant: acfg(o) } },
    state: emptyState(),
    now: new Date("2026-10-22T10:00:00Z"),
    mail: {
      listInbox: async () => inbox,
      createReplyDraft: async (messageId, text) => {
        drafts.push({ messageId, text });
        return { id: `d-${messageId}` };
      },
      sendDraft: async (id) => {
        sentDrafts.push(id);
      },
    },
    notifier: bot,
    writer,
    chat: HENRI,
    log: () => {},
  };
  return { ctx, bot, drafts, sentDrafts };
}

const press = (n: number, action: "send" | "skip", from = HENRI, id = 1): Update => ({
  update_id: id,
  callback_query: { id: `cb${id}`, from: { id: Number(from) }, data: `mail:${action}:${n}`, message: { message_id: 101, chat: { id: Number(HENRI) } } },
});

test("wantsReply: a person asking something, not bulk mail, bills or Henri", () => {
  assert.equal(wantsReply(msg({ from: "anna@gmail.com", subject: "Lauantai", bodyPreview: "Pääsettekö lauantaina?" }), ["henri@outlook.com"]), true);
  assert.equal(wantsReply(msg({ from: "anna@gmail.com", subject: "Kuvat", bodyPreview: "Tässä kuvat eiliseltä." }), []), false);
  assert.equal(wantsReply(msg({ from: "noreply@vero.fi", subject: "Voitko tarkistaa?" }), []), false);
  assert.equal(wantsReply(msg({ from: "news@shop.fi", subject: "Tiesitkö?", internetMessageHeaders: [{ name: "List-Unsubscribe", value: "x" }] }), []), false);
  assert.equal(wantsReply(msg({ from: "henri@outlook.com", subject: "Muistiin?" }), ["henri@outlook.com"]), false);
});

test("offers a draft per mail once, and skips mail the writer says needs no answer", async () => {
  const inbox = [msg({ id: "a", from: "anna@gmail.com", subject: "Sopiiko ti?" }), msg({ id: "b", from: "pekka@gmail.com", subject: "FYI: voitko katsoa?" })];
  const { ctx, bot, drafts } = setup({}, inbox);
  await offerReplies(ctx);
  assert.deepEqual(drafts.map((d) => d.messageId), ["a"]);
  assert.equal(bot.sent.length, 1);
  assert.deepEqual(bot.sent[0].buttons.map((b) => b.data), ["mail:send:2", "mail:skip:2"]);
  ctx.state.outlook.assistLastScan = undefined;
  await offerReplies(ctx);
  assert.equal(bot.sent.length, 1, "nothing offered twice");
});

test("Send does nothing while sending is off, sends once it is on, and only for Henri", async () => {
  const { ctx, bot, sentDrafts } = setup({}, [msg({ id: "a", from: "anna@gmail.com", subject: "Sopiiko ti?" })]);
  await offerReplies(ctx);
  bot.queue = [press(1, "send")];
  await handleUpdates(ctx);
  assert.deepEqual(sentDrafts, []);
  assert.match(bot.answers[0], /ei ole vielä päällä/);

  ctx.cfg.outlook.assistant!.send = true;
  bot.queue = [press(1, "send", "999", 2)];
  await handleUpdates(ctx);
  assert.deepEqual(sentDrafts, [], "someone else pressing Send is ignored");

  bot.queue = [press(1, "send", HENRI, 3), press(1, "send", HENRI, 4)];
  await handleUpdates(ctx);
  assert.deepEqual(sentDrafts, ["d-a"], "sent exactly once");
  assert.equal(ctx.state.telegramOffset, 5);
  assert.equal(ctx.state.outlook.replies![0].status, "sent");
});

test("manual mode: Henri's typed reply becomes the draft", async () => {
  const { ctx, bot, drafts } = setup({ writer: "manual" }, [msg({ id: "a", from: "anna@gmail.com", subject: "Sopiiko ti?" })]);
  ctx.writer = undefined;
  await offerReplies(ctx);
  assert.equal(drafts.length, 0);
  bot.queue = [{ update_id: 1, message: { message_id: 5, from: { id: Number(HENRI) }, chat: { id: Number(HENRI), type: "private" }, text: "Käy, tullaan klo 18", reply_to_message: { message_id: 101 } } }];
  await handleUpdates(ctx);
  assert.deepEqual(drafts, [{ messageId: "a", text: "Käy, tullaan klo 18" }]);
  assert.equal(ctx.state.outlook.replies![0].status, "pending");
});

test("every send endpoint stays blocked outside the approved path", () => {
  for (const p of ["/me/sendMail", "/me/messages/x/send", "/me/messages/x/reply", "/me/messages/x/forward"]) assert.throws(() => assertNoSend("POST", p));
});
