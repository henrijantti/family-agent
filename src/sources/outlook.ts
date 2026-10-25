import { readFileSync } from "node:fs";
import { env, requireEnv } from "../config.js";
import type { Bill, StateData } from "../lib/state.js";
import { addDays, daysBetween } from "../lib/time.js";

// Henri's personal Outlook.com mailbox through Microsoft Graph, with his own
// app registration (personal accounts only, public client, device-code
// sign-in). Delegated scopes: Mail.ReadWrite, MailboxSettings.ReadWrite,
// offline_access. The client refuses every send endpoint except one:
// sendDraft(), used only by the Email agent's mail_send tool, which OpenClaw
// holds for Henri's approval and which sends only plain replies to the
// original sender (src/agent/mail-tools.ts). It works only with
// outlook.email_agent.send on, which also requests Mail.Send (the sign-in is
// redone once).

const AUTHORITY = "https://login.microsoftonline.com/consumers/oauth2/v2.0";
const GRAPH = "https://graph.microsoft.com/v1.0";
export const SCOPES = "https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/MailboxSettings.ReadWrite offline_access";
export const scopes = (send: boolean) => (send ? `${SCOPES} https://graph.microsoft.com/Mail.Send` : SCOPES);

export interface MailMessage {
  id: string;
  subject: string;
  from?: { emailAddress: { name?: string; address: string } };
  receivedDateTime: string;
  bodyPreview?: string;
  body?: { contentType: "text" | "html"; content: string };
  hasAttachments?: boolean;
  flag?: { flagStatus: string };
  categories?: string[];
  importance?: "low" | "normal" | "high";
  internetMessageHeaders?: { name: string; value: string }[];
  toRecipients?: { emailAddress: { name?: string; address: string } }[];
  ccRecipients?: { emailAddress: { name?: string; address: string } }[];
  bccRecipients?: { emailAddress: { name?: string; address: string } }[];
  isDraft?: boolean;
  conversationId?: string;
}

export interface MailApi {
  listSince(sinceIso: string): Promise<MailMessage[]>;
  flag(messageId: string, dueDate?: string): Promise<void>;
  createReplyDraft(messageId: string, text: string): Promise<{ id: string }>;
  listFolders(): Promise<{ id: string; displayName: string }[]>;
  createFolder(name: string, parentId?: string): Promise<{ id: string }>;
  move(messageId: string, folderId: string): Promise<void>;
  createRule(rule: unknown): Promise<void>;
  listRules(): Promise<{ id: string; displayName: string }[]>;
}

export const WILMA_RULE = "Family agent: Wilma";

/**
 * Wilma's notification emails skip the inbox: an Outlook rule moves them,
 * read, into their own folder. Creates the folder and rule once; later calls
 * find them and do nothing.
 */
export async function ensureWilmaRule(mail: MailApi, folderName: string, senders: string[]): Promise<"created" | "exists"> {
  if ((await mail.listRules()).some((r) => r.displayName === WILMA_RULE)) return "exists";
  const folder = (await mail.listFolders()).find((f) => f.displayName === folderName) ?? (await mail.createFolder(folderName));
  await mail.createRule({
    displayName: WILMA_RULE,
    sequence: 1,
    isEnabled: true,
    conditions: { senderContains: senders },
    actions: { moveToFolder: folder.id, markAsRead: true, stopProcessingRules: true },
  });
  return "created";
}

/** Refuses anything that could send mail, whatever calls it. */
export function assertNoSend(method: string, path: string) {
  if (/\/send(Mail)?\b|\/reply(All)?$|\/forward$/i.test(path.split("?")[0])) {
    throw new Error(`Blocked: ${method} ${path} would send mail. The agent only writes drafts.`);
  }
}

export class GraphMail implements MailApi {
  private access?: { token: string; exp: number };
  constructor(
    private clientId: string,
    private state: StateData,
    private canSend = false,
  ) {}

  static fromEnv(state: StateData, canSend = false) {
    return new GraphMail(requireEnv("OUTLOOK_CLIENT_ID"), state, canSend);
  }

  private async token(): Promise<string> {
    if (this.access && this.access.exp > Date.now() + 60_000) return this.access.token;
    const refresh = this.state.outlook.refreshToken ?? env("OUTLOOK_REFRESH_TOKEN");
    if (!refresh) throw new Error("Outlook is not signed in yet: run the 'Outlook sign-in' workflow");
    const res = await fetch(`${AUTHORITY}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: this.clientId, grant_type: "refresh_token", refresh_token: refresh, scope: scopes(this.canSend) }),
    });
    const j = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string };
    if (!res.ok || !j.access_token) throw new Error(`Outlook sign-in expired or revoked (${j.error}); run the 'Outlook sign-in' workflow again`);
    // Microsoft rotates refresh tokens: keep the newest, encrypted in state.
    if (j.refresh_token) this.state.outlook.refreshToken = j.refresh_token;
    this.access = { token: j.access_token, exp: Date.now() + (j.expires_in ?? 3600) * 1000 };
    return j.access_token;
  }

  private async call<T>(method: string, path: string, body?: unknown, allowSend = false): Promise<T> {
    if (!allowSend) assertNoSend(method, path);
    const res = await fetch(path.startsWith("http") ? path : `${GRAPH}${path}`, {
      method,
      headers: { authorization: `Bearer ${await this.token()}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Graph ${method} ${path.split("?")[0]}: ${res.status} ${(await res.text()).slice(0, 300)}`);
    return (res.status === 202 || res.status === 204 ? undefined : await res.json()) as T;
  }

  async listSince(sinceIso: string) {
    const q = new URLSearchParams({
      $filter: `receivedDateTime ge ${sinceIso}`,
      $select: "id,subject,from,receivedDateTime,bodyPreview,body,hasAttachments,flag",
      $orderby: "receivedDateTime desc",
      $top: "50",
    });
    const out: MailMessage[] = [];
    let next: string | undefined = `/me/mailFolders/inbox/messages?${q}`;
    while (next && out.length < 500) {
      const page: { value: MailMessage[]; "@odata.nextLink"?: string } = await this.call("GET", next);
      out.push(...page.value);
      next = page["@odata.nextLink"];
    }
    return out;
  }

  /** Inbox (or another folder's) messages since a date, with headers (for List-Unsubscribe). Read-only. */
  async listInbox(sinceIso: string, max: number, folderId = "inbox") {
    const q = new URLSearchParams({
      $filter: `receivedDateTime ge ${sinceIso}`,
      $select: "id,subject,from,receivedDateTime,bodyPreview,body,flag,categories,importance,internetMessageHeaders",
      $orderby: "receivedDateTime desc",
      $top: "50",
    });
    const out: MailMessage[] = [];
    let next: string | undefined = `/me/mailFolders/${encodeURIComponent(folderId)}/messages?${q}`;
    while (next && out.length < max) {
      const page: { value: MailMessage[]; "@odata.nextLink"?: string } = await this.call("GET", next);
      out.push(...page.value);
      next = page["@odata.nextLink"];
    }
    return out.slice(0, max);
  }

  /**
   * Labels in Graph JSON batches of 20 (one request per batch instead of per
   * message); throttled ones are retried after the wait Graph asks for.
   */
  async labelMany(ops: { id: string; categories: string[]; flag: boolean }[]) {
    let pending = ops;
    let failed = 0;
    for (let attempt = 0; attempt < 4 && pending.length; attempt++) {
      const retry: typeof ops = [];
      let wait = 0;
      for (let i = 0; i < pending.length; i += 20) {
        const chunk = pending.slice(i, i + 20);
        const res = await this.call<{ responses: { id: string; status: number; headers?: Record<string, string> }[] }>("POST", "/$batch", {
          requests: chunk.map((o, n) => ({
            id: String(n),
            method: "PATCH",
            url: `/me/messages/${o.id}`,
            headers: { "content-type": "application/json" },
            body: { categories: o.categories, ...(o.flag ? { flag: { flagStatus: "flagged" } } : {}) },
          })),
        });
        for (const r of res.responses) {
          if (r.status < 300) continue;
          if (r.status === 429 || r.status >= 500) {
            retry.push(chunk[Number(r.id)]);
            wait = Math.max(wait, Number(r.headers?.["Retry-After"] ?? r.headers?.["retry-after"] ?? 5));
          } else failed++;
        }
      }
      pending = retry;
      if (pending.length) await new Promise((ok) => setTimeout(ok, Math.min(wait, 60) * 1000));
    }
    return failed + pending.length;
  }

  /** Inbox messages received in [fromIso, toIso): enough to sort, no body. Read-only. */
  async listRange(fromIso: string, toIso: string) {
    const q = new URLSearchParams({
      $filter: `receivedDateTime ge ${fromIso} and receivedDateTime lt ${toIso}`,
      $select: "id,subject,from,receivedDateTime,bodyPreview,flag,categories,internetMessageHeaders",
      $orderby: "receivedDateTime desc",
      $top: "100",
    });
    const out: MailMessage[] = [];
    let next: string | undefined = `/me/mailFolders/inbox/messages?${q}`;
    while (next && out.length < 50000) {
      const page: { value: MailMessage[]; "@odata.nextLink"?: string } = await this.call("GET", next);
      out.push(...page.value);
      next = page["@odata.nextLink"];
    }
    return out;
  }

  /** Moves in JSON batches of 20, retrying throttled ones; each result has the moved mail's new id. */
  async moveMany(ops: { id: string; folderId: string }[]) {
    const out = new Map<string, { id: string; newId?: string; error?: string }>();
    let pending = ops;
    for (let attempt = 0; attempt < 4 && pending.length; attempt++) {
      const retry: typeof ops = [];
      let wait = 0;
      for (let i = 0; i < pending.length; i += 20) {
        const chunk = pending.slice(i, i + 20);
        let res: { responses: { id: string; status: number; headers?: Record<string, string>; body?: { id?: string } }[] };
        try {
          res = await this.call("POST", "/$batch", {
            requests: chunk.map((o, n) => ({
              id: String(n),
              method: "POST",
              url: `/me/messages/${o.id}/move`,
              headers: { "content-type": "application/json" },
              body: { destinationId: o.folderId },
            })),
          });
        } catch (e) {
          // Keep what earlier requests moved: their new ids must reach the move log.
          for (const op of chunk) out.set(op.id, { id: op.id, error: (e as Error).message.slice(0, 120) });
          continue;
        }
        for (const r of res.responses) {
          const op = chunk[Number(r.id)];
          if (r.status < 300 && r.body?.id) out.set(op.id, { id: op.id, newId: r.body.id });
          else if (r.status === 429 || r.status >= 500) {
            retry.push(op);
            wait = Math.max(wait, Number(r.headers?.["Retry-After"] ?? r.headers?.["retry-after"] ?? 5));
          } else out.set(op.id, { id: op.id, error: String(r.status) });
        }
      }
      pending = retry;
      if (pending.length) await new Promise((ok) => setTimeout(ok, Math.min(wait, 60) * 1000));
    }
    for (const op of pending) out.set(op.id, { id: op.id, error: "throttled" });
    return ops.map((o) => out.get(o.id)!);
  }

  async unflag(messageId: string) {
    await this.call("PATCH", `/me/messages/${messageId}`, { flag: { flagStatus: "notFlagged" } });
  }

  /** Creates the coloured category labels if they don't exist yet. */
  async ensureCategories(cats: { name: string; color: string }[]) {
    const have = (await this.call<{ value: { displayName: string }[] }>("GET", "/me/outlook/masterCategories")).value.map((c) => c.displayName);
    for (const c of cats) if (!have.includes(c.name)) await this.call("POST", "/me/outlook/masterCategories", { displayName: c.name, color: c.color });
  }

  async flag(messageId: string, dueDate?: string) {
    // Graph rejects a due date without a start date, or a start after the due date.
    const today = new Date().toISOString().slice(0, 10);
    const at = (d: string) => ({ dateTime: `${d}T09:00:00`, timeZone: "FLE Standard Time" });
    const dates = dueDate ? { startDateTime: at(dueDate < today ? dueDate : today), dueDateTime: at(dueDate) } : {};
    await this.call("PATCH", `/me/messages/${messageId}`, { flag: { flagStatus: "flagged", ...dates } });
  }

  async createReplyDraft(messageId: string, text: string) {
    // createReply only creates a draft in Drafts; it never sends.
    return this.call<{ id: string }>("POST", `/me/messages/${messageId}/createReply`, { comment: text });
  }

  /** One message with recipients and body, for reading or checking a draft. */
  getMessage(id: string) {
    const q = "$select=id,subject,from,toRecipients,ccRecipients,bccRecipients,receivedDateTime,bodyPreview,body,categories,flag,isDraft,conversationId";
    return this.call<MailMessage>("GET", `/me/messages/${encodeURIComponent(id)}?${q}`);
  }

  /** File attachments of one message: id, type and size only (names are the sender's text). */
  async listAttachments(messageId: string) {
    const r = await this.call<{ value: { id: string; contentType?: string; size?: number; isInline?: boolean; "@odata.type"?: string }[] }>(
      "GET",
      `/me/messages/${encodeURIComponent(messageId)}/attachments?$select=id,contentType,size,isInline`,
    );
    return r.value
      .filter((a) => !a["@odata.type"] || a["@odata.type"] === "#microsoft.graph.fileAttachment")
      .map((a) => ({ id: a.id, contentType: a.contentType ?? "", size: a.size ?? 0, isInline: !!a.isInline }));
  }

  /** One file attachment's bytes. */
  async attachmentBytes(messageId: string, attachmentId: string): Promise<Uint8Array> {
    const a = await this.call<{ contentBytes?: string }>("GET", `/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`);
    if (!a.contentBytes) throw new Error("attachment has no content");
    return new Uint8Array(Buffer.from(a.contentBytes, "base64"));
  }

  async setCategories(id: string, categories: string[]) {
    await this.call("PATCH", `/me/messages/${encodeURIComponent(id)}`, { categories });
  }

  /** Ids of well-known folders (deleteditems, junkemail, archive, ...); missing ones are left out. */
  async wellKnownFolderIds(names: string[]) {
    const out: Record<string, string> = {};
    for (const n of names) {
      const f = await this.call<{ id: string }>("GET", `/me/mailFolders/${n}?$select=id`).catch(() => undefined);
      if (f) out[n] = f.id;
    }
    return out;
  }

  /**
   * Sends one existing draft, as it now stands in Drafts (Henri may have
   * edited it). Only the Email agent's mail_send tool calls this.
   */
  async sendDraft(draftId: string) {
    if (!this.canSend) throw new Error("Sending is off (outlook.email_agent.send)");
    await this.call("POST", `/me/messages/${encodeURIComponent(draftId)}/send`, undefined, true);
  }

  async listFolders() {
    return (await this.call<{ value: { id: string; displayName: string; totalItemCount?: number; unreadItemCount?: number }[] }>("GET", "/me/mailFolders?$top=100")).value;
  }

  createFolder(name: string, parentId?: string) {
    return this.call<{ id: string }>("POST", parentId ? `/me/mailFolders/${parentId}/childFolders` : "/me/mailFolders", { displayName: name });
  }

  async move(messageId: string, folderId: string) {
    await this.call("POST", `/me/messages/${messageId}/move`, { destinationId: folderId });
  }

  async createRule(rule: unknown) {
    await this.call("POST", "/me/mailFolders/inbox/messageRules", rule);
  }

  async listRules() {
    return (await this.call<{ value: { id: string; displayName: string }[] }>("GET", "/me/mailFolders/inbox/messageRules")).value;
  }
}

/** Device-code sign-in: prints a short code for microsoft.com/devicelogin; the refresh token goes to state only. */
export async function deviceSignIn(clientId: string, state: StateData, log: (s: string) => void, scope = SCOPES) {
  const start = await fetch(`${AUTHORITY}/devicecode`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, scope }),
  });
  const dc = (await start.json()) as { device_code: string; user_code: string; verification_uri: string; interval: number; expires_in: number; error_description?: string };
  if (!start.ok) throw new Error(`Device code request failed: ${dc.error_description}`);
  log(`Open ${dc.verification_uri} and enter the code ${dc.user_code} (valid ${Math.round(dc.expires_in / 60)} minutes).`);
  const until = Date.now() + dc.expires_in * 1000;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, (dc.interval || 5) * 1000));
    const res = await fetch(`${AUTHORITY}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId, grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: dc.device_code }),
    });
    const j = (await res.json()) as { refresh_token?: string; error?: string };
    if (j.refresh_token) {
      state.outlook.refreshToken = j.refresh_token;
      log("Signed in. The token is stored encrypted in the agent state; it was not printed.");
      return;
    }
    if (j.error !== "authorization_pending" && j.error !== "slow_down") throw new Error(`Sign-in failed: ${j.error}`);
  }
  throw new Error("Sign-in code expired; run the workflow again");
}

export class FixtureMail implements MailApi {
  flagged: string[] = [];
  drafts: { messageId: string; text: string }[] = [];
  constructor(private path: string) {}
  async listSince() {
    return JSON.parse(readFileSync(this.path, "utf8")) as MailMessage[];
  }
  async flag(id: string) {
    this.flagged.push(id);
  }
  async createReplyDraft(messageId: string, text: string) {
    this.drafts.push({ messageId, text });
    return { id: `draft-${messageId}` };
  }
  async listFolders() {
    return [{ id: "inbox", displayName: "Inbox" }];
  }
  async createFolder(name: string) {
    return { id: name };
  }
  async move() {}
  rules: { id: string; displayName: string }[] = [];
  async createRule(rule: unknown) {
    this.rules.push({ id: String(this.rules.length + 1), displayName: (rule as { displayName: string }).displayName });
  }
  async listRules() {
    return this.rules;
  }
}

// ---------- invoice detection (pure, tested) ----------

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&euro;/g, "€")
    .replace(/[ \t]+/g, " ");
}

const INVOICE_WORDS = /\b(lasku|laskun|laskunne|e-lasku|maksumuistutus|eräpäivä|viitenumero|invoice|bill|payment due|due date|reference number)\b/i;
const DATE_RE = /(\d{1,2})\.(\d{1,2})\.(\d{4})|(\d{4})-(\d{2})-(\d{2})/;

function toIsoDate(m: RegExpMatchArray): string | undefined {
  if (m[1]) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  if (m[4]) return `${m[4]}-${m[5]}-${m[6]}`;
}

export function detectInvoice(msg: MailMessage): Omit<Bill, "newBiller" | "foundAt"> | null {
  const text = `${msg.subject}\n${msg.body ? (msg.body.contentType === "html" ? htmlToText(msg.body.content) : msg.body.content) : msg.bodyPreview ?? ""}`;
  if (!INVOICE_WORDS.test(text)) return null;
  // Newsletters mention "lasku" too; require an amount or a due date.
  const due = text.match(new RegExp(`(?:eräpäivä|erääntyy|maksettava viimeistään|due date|payment due|due)[^\\d]{0,30}(?:${DATE_RE.source})`, "i"));
  const amount =
    text.match(/(?:yhteensä|summa|maksettava|loppusumma|määrä|amount|total|due)[^\d]{0,30}(\d{1,3}(?:[ .]\d{3})*(?:[.,]\d{2})?)\s*(€|eur|euroa)/i) ??
    text.match(/(\d{1,3}(?:[ .]\d{3})*[.,]\d{2})\s*(€|eur)\b/i) ??
    // "Summa: EUR 120,00" / "€ 45.00" (currency first, as in MyClub invoices)
    text.match(/(?:€|eur)\s*(\d{1,3}(?:[ .]\d{3})*[.,]\d{2})\b/i) ??
    text.match(/(?:yhteensä|summa|maksettava|loppusumma|hinta|amount|total)\s*:?\s*(\d{1,3}(?:[ .]\d{3})*[.,]\d{2})\b/i);
  const ref = text.match(/(?:viitenumero|viite|reference number|reference|ref\.?)\s*:?\s*(RF\d{2}[\d ]{4,25}\d|\d[\d ]{3,25}\d)/i);
  if (!due && !amount) return null;
  // Receipts and payment confirmations quote an amount too, but are already paid:
  // without a due date, only a payment request or reminder counts as a bill.
  if (!due && !/(maksumuistutus|maksettava|erääntyy|amount due|payment due|please pay|maksa viimeistään)/i.test(text)) return null;
  const dueDate = due ? toIsoDate(due) : undefined;
  const sender = msg.from?.emailAddress.address ?? "unknown";
  return {
    messageId: msg.id,
    biller: msg.from?.emailAddress.name || sender.split("@")[1] || sender,
    sender,
    amount: amount ? `${amount[1].replace(/\s/g, "")} €` : undefined,
    dueDate,
    reference: ref?.[1].replace(/\s+/g, " ").trim(),
    subject: msg.subject,
  };
}

export interface ScanResult {
  scanned: number;
  newBills: Bill[];
}

export async function scanInvoices(api: MailApi, state: StateData, lookbackDays: number, now = new Date()): Promise<ScanResult> {
  const since = state.outlook.lastScan ?? new Date(now.getTime() - lookbackDays * 86400000).toISOString();
  const msgs = await api.listSince(since.replace(/\.\d{3}Z$/, "Z"));
  const known = new Set(state.outlook.bills.map((b) => b.messageId));
  const newBills: Bill[] = [];
  // On the very first scan every biller is unknown; don't flag them all as suspicious.
  const firstScan = !state.outlook.lastScan && state.outlook.knownBillers.length === 0;
  for (const m of msgs) {
    if (known.has(m.id)) {
      // Fill in an amount an earlier parser missed.
      const b = state.outlook.bills.find((x) => x.messageId === m.id);
      if (b && !b.amount) b.amount = detectInvoice(m)?.amount;
      continue;
    }
    const found = detectInvoice(m);
    if (!found) continue;
    const domain = found.sender.split("@")[1] ?? found.sender;
    const bill: Bill = { ...found, newBiller: !firstScan && !state.outlook.knownBillers.includes(domain), foundAt: now.toISOString() };
    if (!state.outlook.knownBillers.includes(domain)) state.outlook.knownBillers.push(domain);
    state.outlook.bills.push(bill);
    newBills.push(bill);
    // A flag is a convenience; the bill is already recorded, so one bad message mustn't stop the scan.
    await api.flag(m.id, bill.dueDate).catch((e) => console.warn(`could not flag a bill from ${domain}: ${(e as Error).message}`));
  }
  state.outlook.lastScan = now.toISOString();
  // Forget bills well past due.
  const today = now.toISOString().slice(0, 10);
  state.outlook.bills = state.outlook.bills.filter((b) => !b.dueDate || b.dueDate >= addDays(today, -14));
  return { scanned: msgs.length, newBills };
}

/** Bills to remind about today: due in exactly N days, due today, or overdue in the last week. */
export function billsToRemind(state: StateData, today: string, daysBefore: number): (Bill & { inDays: number })[] {
  return state.outlook.bills
    .filter((b) => b.dueDate)
    .map((b) => ({ ...b, inDays: daysBetween(today, b.dueDate!) }))
    .filter((b) => b.inDays === daysBefore || (b.inDays <= 0 && b.inDays >= -7) || (b.inDays > 0 && b.inDays < daysBefore))
    .sort((a, b) => a.inDays - b.inDays);
}
