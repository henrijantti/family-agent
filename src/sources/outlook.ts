import { readFileSync } from "node:fs";
import { env, requireEnv } from "../config.js";
import type { Bill, StateData } from "../lib/state.js";
import { addDays, daysBetween } from "../lib/time.js";

// Henri's personal Outlook.com mailbox through Microsoft Graph, with his own
// app registration (personal accounts only, public client, device-code
// sign-in). Delegated scopes: Mail.ReadWrite, MailboxSettings.ReadWrite,
// offline_access. There is no Mail.Send scope and the client below refuses
// any send endpoint, so nothing can ever be sent: replies are drafts only.

const AUTHORITY = "https://login.microsoftonline.com/consumers/oauth2/v2.0";
const GRAPH = "https://graph.microsoft.com/v1.0";
export const SCOPES = "https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/MailboxSettings.ReadWrite offline_access";

export interface MailMessage {
  id: string;
  subject: string;
  from?: { emailAddress: { name?: string; address: string } };
  receivedDateTime: string;
  bodyPreview?: string;
  body?: { contentType: "text" | "html"; content: string };
  hasAttachments?: boolean;
  flag?: { flagStatus: string };
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
  ) {}

  static fromEnv(state: StateData) {
    return new GraphMail(requireEnv("OUTLOOK_CLIENT_ID"), state);
  }

  private async token(): Promise<string> {
    if (this.access && this.access.exp > Date.now() + 60_000) return this.access.token;
    const refresh = this.state.outlook.refreshToken ?? env("OUTLOOK_REFRESH_TOKEN");
    if (!refresh) throw new Error("Outlook is not signed in yet: run the 'Outlook sign-in' workflow");
    const res = await fetch(`${AUTHORITY}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: this.clientId, grant_type: "refresh_token", refresh_token: refresh, scope: SCOPES }),
    });
    const j = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string };
    if (!res.ok || !j.access_token) throw new Error(`Outlook sign-in expired or revoked (${j.error}); run the 'Outlook sign-in' workflow again`);
    // Microsoft rotates refresh tokens: keep the newest, encrypted in state.
    if (j.refresh_token) this.state.outlook.refreshToken = j.refresh_token;
    this.access = { token: j.access_token, exp: Date.now() + (j.expires_in ?? 3600) * 1000 };
    return j.access_token;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    assertNoSend(method, path);
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

  async flag(messageId: string, dueDate?: string) {
    await this.call("PATCH", `/me/messages/${messageId}`, {
      flag: { flagStatus: "flagged", ...(dueDate ? { dueDateTime: { dateTime: `${dueDate}T09:00:00`, timeZone: "FLE Standard Time" } } : {}) },
    });
  }

  async createReplyDraft(messageId: string, text: string) {
    // createReply only creates a draft in Drafts; it never sends.
    return this.call<{ id: string }>("POST", `/me/messages/${messageId}/createReply`, { comment: text });
  }

  async listFolders() {
    return (await this.call<{ value: { id: string; displayName: string }[] }>("GET", "/me/mailFolders?$top=100")).value;
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
export async function deviceSignIn(clientId: string, state: StateData, log: (s: string) => void) {
  const start = await fetch(`${AUTHORITY}/devicecode`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, scope: SCOPES }),
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
  const amount = text.match(/(?:yhteensä|summa|maksettava|loppusumma|määrä|amount|total|due)[^\d]{0,30}(\d{1,3}(?:[ .]\d{3})*(?:[.,]\d{2})?)\s*(€|eur|euroa)/i) ?? text.match(/(\d{1,3}(?:[ .]\d{3})*[.,]\d{2})\s*(€|eur)\b/i);
  const ref = text.match(/(?:viitenumero|viite|reference number|reference|ref\.?)\s*:?\s*(RF\d{2}[\d ]{4,25}\d|\d[\d ]{3,25}\d)/i);
  if (!due && !amount) return null;
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
    if (known.has(m.id)) continue;
    const found = detectInvoice(m);
    if (!found) continue;
    const domain = found.sender.split("@")[1] ?? found.sender;
    const bill: Bill = { ...found, newBiller: !firstScan && !state.outlook.knownBillers.includes(domain), foundAt: now.toISOString() };
    if (!state.outlook.knownBillers.includes(domain)) state.outlook.knownBillers.push(domain);
    state.outlook.bills.push(bill);
    newBills.push(bill);
    await api.flag(m.id, bill.dueDate);
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
