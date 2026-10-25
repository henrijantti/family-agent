import { requireEnv } from "../config.js";

// Telegram bot. It posts the digest and alerts, and the weekly practice
// polls; it never acts on chat messages. Poll answers are read by closing the
// poll, so the bot never has to read the group's conversation.

export interface Notifier {
  send(chatId: string, html: string): Promise<void>;
  /** Multiple-choice, non-anonymous poll. */
  poll?(chatId: string, question: string, options: string[]): Promise<{ messageId: number }>;
  /** Closes the poll and returns the voter count per option. */
  stopPoll?(chatId: string, messageId: number): Promise<number[]>;
  /** PNG photo with an HTML caption; returns the message id. */
  photo?(chatId: string, png: Buffer, caption: string): Promise<{ messageId: number }>;
  /** Replaces the photo and caption of a message the bot sent. */
  editPhoto?(chatId: string, messageId: number, png: Buffer, caption: string): Promise<void>;
  /** Pins a message without notifying the members. */
  pin?(chatId: string, messageId: number): Promise<void>;
}

const LIMIT = 4000; // Telegram's hard limit is 4096

export function chunk(html: string): string[] {
  if (html.length <= LIMIT) return [html];
  const parts: string[] = [];
  let cur = "";
  for (const line of html.split("\n")) {
    if (cur.length + line.length + 1 > LIMIT && cur) {
      parts.push(cur);
      cur = "";
    }
    cur += (cur ? "\n" : "") + line;
  }
  if (cur) parts.push(cur);
  return parts;
}

export class TelegramBot implements Notifier {
  constructor(private token: string) {}
  static fromEnv() {
    return new TelegramBot(requireEnv("TELEGRAM_BOT_TOKEN"));
  }

  private async api<T>(method: string, body?: unknown): Promise<T> {
    const res = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    const j = (await res.json()) as { ok: boolean; result: T; description?: string };
    if (!j.ok) throw new Error(`Telegram ${method}: ${j.description}`);
    return j.result;
  }

  private async upload<T>(method: string, fields: Record<string, string>, png: Buffer): Promise<T> {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    form.append("photo", new Blob([new Uint8Array(png)], { type: "image/png" }), "perhe.png");
    const res = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, { method: "POST", body: form });
    const j = (await res.json()) as { ok: boolean; result: T; description?: string };
    if (!j.ok) throw new Error(`Telegram ${method}: ${j.description}`);
    return j.result;
  }

  async photo(chatId: string, png: Buffer, caption: string) {
    const m = await this.upload<{ message_id: number }>("sendPhoto", { chat_id: chatId, caption, parse_mode: "HTML", disable_notification: "true" }, png);
    return { messageId: m.message_id };
  }

  async editPhoto(chatId: string, messageId: number, png: Buffer, caption: string) {
    const media = JSON.stringify({ type: "photo", media: "attach://photo", caption, parse_mode: "HTML" });
    try {
      await this.upload("editMessageMedia", { chat_id: chatId, message_id: String(messageId), media }, png);
    } catch (e) {
      if (!/message is not modified/i.test(String(e))) throw e;
    }
  }

  async pin(chatId: string, messageId: number) {
    await this.api("pinChatMessage", { chat_id: chatId, message_id: messageId, disable_notification: true });
  }

  async send(chatId: string, html: string) {
    for (const part of chunk(html)) {
      await this.api("sendMessage", { chat_id: chatId, text: part, parse_mode: "HTML", disable_web_page_preview: true });
    }
  }

  async poll(chatId: string, question: string, options: string[]) {
    const m = await this.api<{ message_id: number }>("sendPoll", {
      chat_id: chatId,
      question: question.slice(0, 300),
      options: options.map((text) => ({ text: text.slice(0, 100) })),
      is_anonymous: false,
      allows_multiple_answers: true,
    });
    return { messageId: m.message_id };
  }

  async stopPoll(chatId: string, messageId: number) {
    const p = await this.api<{ options: { voter_count: number }[] }>("stopPoll", { chat_id: chatId, message_id: messageId });
    return p.options.map((o) => o.voter_count);
  }

  /** Lists chats the bot has seen, to find the family group's chat id during setup. */
  async chats(): Promise<{ id: number; title: string; type: string }[]> {
    const updates = await this.api<{ message?: { chat: { id: number; title?: string; first_name?: string; type: string } }; my_chat_member?: { chat: { id: number; title?: string; type: string } } }[]>("getUpdates");
    const m = new Map<number, { id: number; title: string; type: string }>();
    for (const u of updates) {
      const c = u.message?.chat ?? u.my_chat_member?.chat;
      if (c) m.set(c.id, { id: c.id, title: ("title" in c && c.title) || ("first_name" in c ? String(c.first_name) : ""), type: c.type });
    }
    return [...m.values()];
  }
}

export class ConsoleNotifier implements Notifier {
  sent: { chatId: string; html: string }[] = [];
  photos: { chatId: string; messageId: number; bytes: number; caption: string; pinned: boolean; edits: number }[] = [];
  polls: { chatId: string; question: string; options: string[]; votes: number[]; closed: boolean }[] = [];
  constructor(private print = true) {}
  async poll(chatId: string, question: string, options: string[]) {
    this.polls.push({ chatId, question, options, votes: options.map(() => 0), closed: false });
    if (this.print) console.log(`\n--- Telegram poll to ${chatId} ---\n${question}\n${options.map((o) => `  [ ] ${o}`).join("\n")}\n`);
    return { messageId: this.polls.length };
  }
  async photo(chatId: string, png: Buffer, caption: string) {
    const messageId = 1000 + this.photos.length;
    this.photos.push({ chatId, messageId, bytes: png.length, caption, pinned: false, edits: 0 });
    if (this.print) console.log(`\n--- Telegram photo to ${chatId} (${png.length} bytes) ---\n${caption}\n`);
    return { messageId };
  }
  async editPhoto(_chatId: string, messageId: number, png: Buffer, caption: string) {
    const p = this.photos.find((x) => x.messageId === messageId);
    if (!p) throw new Error("Telegram editMessageMedia: Bad Request: message to edit not found");
    Object.assign(p, { bytes: png.length, caption, edits: p.edits + 1 });
  }
  async pin(_chatId: string, messageId: number) {
    const p = this.photos.find((x) => x.messageId === messageId);
    if (p) p.pinned = true;
  }
  async stopPoll(_chatId: string, messageId: number) {
    const p = this.polls[messageId - 1];
    p.closed = true;
    return p.votes;
  }
  async send(chatId: string, html: string) {
    this.sent.push({ chatId, html });
    if (this.print) console.log(`\n--- Telegram to ${chatId} ---\n${html.replace(/<\/?[bi]>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")}\n`);
  }
}

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
