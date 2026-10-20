import { requireEnv } from "../config.js";

// Send-only Telegram bot. It posts the digest and alerts and never acts on
// messages in the group.

export interface Notifier {
  send(chatId: string, html: string): Promise<void>;
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
  constructor(private print = true) {}
  async send(chatId: string, html: string) {
    this.sent.push({ chatId, html });
    if (this.print) console.log(`\n--- Telegram to ${chatId} ---\n${html.replace(/<\/?[bi]>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")}\n`);
  }
}

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
