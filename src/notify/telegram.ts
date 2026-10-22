import { requireEnv } from "../config.js";

// Telegram bot. It posts the digest and alerts, and the weekly practice
// polls. Poll answers are read by closing the poll. The one thing it reads is
// Henri's private chat: email assistant button presses and replies there
// (updates from any other chat are skipped).

export interface Notifier {
  send(chatId: string, html: string): Promise<void>;
  /** Multiple-choice, non-anonymous poll. */
  poll?(chatId: string, question: string, options: string[]): Promise<{ messageId: number }>;
  /** Closes the poll and returns the voter count per option. */
  stopPoll?(chatId: string, messageId: number): Promise<number[]>;
  /** Message with inline buttons; returns its message id. */
  sendButtons?(chatId: string, html: string, buttons: Button[]): Promise<number>;
  /** Button presses and messages since the last call. */
  updates?(offset?: number): Promise<Update[]>;
  answerButton?(callbackId: string, text: string): Promise<void>;
  /** Replaces a message's text and removes its buttons. */
  edit?(chatId: string, messageId: number, html: string): Promise<void>;
}

export interface Button {
  text: string;
  data: string; // at most 64 bytes
}

export interface Update {
  update_id: number;
  callback_query?: { id: string; from: { id: number }; data?: string; message?: { message_id: number; chat: { id: number } } };
  message?: { message_id: number; from?: { id: number }; chat: { id: number; type: string }; text?: string; reply_to_message?: { message_id: number } };
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

  async sendButtons(chatId: string, html: string, buttons: Button[]) {
    const m = await this.api<{ message_id: number }>("sendMessage", {
      chat_id: chatId,
      text: html.slice(0, LIMIT),
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: [buttons.map((b) => ({ text: b.text, callback_data: b.data }))] },
    });
    return m.message_id;
  }

  updates(offset?: number) {
    return this.api<Update[]>("getUpdates", { offset, timeout: 0, allowed_updates: ["callback_query", "message"] });
  }

  async answerButton(callbackId: string, text: string) {
    await this.api("answerCallbackQuery", { callback_query_id: callbackId, text: text.slice(0, 200) });
  }

  async edit(chatId: string, messageId: number, html: string) {
    await this.api("editMessageText", { chat_id: chatId, message_id: messageId, text: html.slice(0, LIMIT), parse_mode: "HTML", disable_web_page_preview: true });
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
  polls: { chatId: string; question: string; options: string[]; votes: number[]; closed: boolean }[] = [];
  constructor(private print = true) {}
  async poll(chatId: string, question: string, options: string[]) {
    this.polls.push({ chatId, question, options, votes: options.map(() => 0), closed: false });
    if (this.print) console.log(`\n--- Telegram poll to ${chatId} ---\n${question}\n${options.map((o) => `  [ ] ${o}`).join("\n")}\n`);
    return { messageId: this.polls.length };
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
