import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { MailRule } from "./agent/mail-tools.js";
import { classify } from "./outlook-triage.js";
import type { MailMessage } from "./sources/outlook.js";

// One-off cleanup of Henri's old Inbox (Henri, 2026-10-24: "clean backlog"),
// one year at a time: plan (counts only), then apply, with a move log that
// undo replays backwards. It only moves out of the Inbox into Uutiskirjeet,
// Ilmoitukset or Kuitit, or a folder Henri taught with mail_rule. Nothing is
// deleted and nothing goes to Junk or Deleted Items. Anything that might be
// for Henri (people, bills, Tärkeä, flagged, replies, authorities) stays.

export const TARGETS = ["Uutiskirjeet", "Ilmoitukset", "Kuitit"] as const;
export const STAY = "Inbox";

const RECEIPT = /(kuitti|receipt|tilausvahvistus|order confirmation|tilauksesi|your order|maksuvahvistus|payment confirmation|payment received|maksu vastaanotettu|kiitos tilauksestasi|thank you for your order|varausvahvistus|booking confirmation)/i;
const NOTIFY_SENDER = /(no-?reply|do-?not-?reply|notifications?@|notify|alerts?@|ilmoitus|automated|mailer-daemon|accounts?@)/i;
const BILL_HINT = /(lasku|invoice|\bbill\b|eräpäivä|erääntyy|muistutus|reminder|payment due|amount due|maksettava|perintä|e-lasku)/i;
// Club mail and Microsoft account security stay where Henri sees them (as in outlook-triage).
const KEEP_SENDER = /(myclub\.fi|accountprotection\.microsoft\.com)$/i;

export interface BacklogApi {
  /** Inbox messages received in [fromIso, toIso), with flag, categories, headers and preview. */
  listRange(fromIso: string, toIso: string): Promise<MailMessage[]>;
  listFolders(): Promise<{ id: string; displayName: string }[]>;
  createFolder(name: string): Promise<{ id: string }>;
  /** Moves many messages; returns the new id of each moved one (Graph gives moved mail a new id). */
  moveMany(ops: { id: string; folderId: string }[]): Promise<{ id: string; newId?: string; error?: string }[]>;
  wellKnownFolderIds(names: string[]): Promise<Record<string, string>>;
}

export interface PlanItem {
  id: string;
  to: string;
}
export interface Plan {
  year: number;
  at: string;
  scanned: number;
  counts: Record<string, number>;
  /** Top sender domains per target folder, for the report (no subjects). */
  domains: Record<string, [string, number][]>;
  items: PlanItem[];
}

const sender = (m: MailMessage) => (m.from?.emailAddress.address ?? "").toLowerCase();

function ruleFor(rules: MailRule[], from: string): MailRule | undefined {
  return rules.find((r) => r.sender === from) ?? rules.find((r) => r.sender.startsWith("@") && from.endsWith(r.sender));
}

/** Where one old Inbox email should go, or Inbox to leave it. */
export function target(m: MailMessage, rules: MailRule[], opts: { skipDomains?: string[]; self?: string[] } = {}): string {
  const from = sender(m);
  const rule = ruleFor(rules, from);
  if (rule) return rule.action === "folder" && rule.folder ? rule.folder : STAY;
  if (m.flag?.flagStatus === "flagged") return STAY;
  if ((m.categories ?? []).some((c) => c === "Tärkeä" || c === "Lasku")) return STAY;
  // The listing has only the preview, so anything that could be a bill stays.
  if (BILL_HINT.test(`${m.subject ?? ""}\n${m.bodyPreview ?? ""}`)) return STAY;
  if ((opts.skipDomains ?? []).some((d) => from.endsWith(d)) || (opts.self ?? []).includes(from) || KEEP_SENDER.test(from)) return STAY;
  const kind = classify(m, opts);
  if (kind === "invoice" || kind === "important") return STAY;
  if (RECEIPT.test(m.subject ?? "")) return "Kuitit";
  if (kind === "newsletter") return NOTIFY_SENDER.test(from) ? "Ilmoitukset" : "Uutiskirjeet";
  if (NOTIFY_SENDER.test(from)) return "Ilmoitukset";
  return STAY;
}

export function makePlan(year: number, msgs: MailMessage[], rules: MailRule[], now: Date, opts: { skipDomains?: string[]; self?: string[] } = {}): Plan {
  const counts: Record<string, number> = { [STAY]: 0 };
  const dom: Record<string, Map<string, number>> = {};
  const items: PlanItem[] = [];
  for (const m of msgs) {
    const to = target(m, rules, opts);
    counts[to] = (counts[to] ?? 0) + 1;
    if (to === STAY) continue;
    items.push({ id: m.id, to });
    const d = sender(m).split("@")[1] ?? "?";
    (dom[to] ??= new Map()).set(d, (dom[to].get(d) ?? 0) + 1);
  }
  const domains = Object.fromEntries(Object.entries(dom).map(([f, mp]) => [f, [...mp].sort((a, b) => b[1] - a[1]).slice(0, 8)]));
  return { year, at: now.toISOString(), scanned: msgs.length, counts, domains, items };
}

/** Over 60% of a year leaving the Inbox looks wrong: stop for a look instead of moving. */
export function looksOdd(p: Plan): boolean {
  return p.scanned > 0 && p.items.length / p.scanned > 0.6;
}

export function planReport(p: Plan): string {
  const lines = [`Vuosi ${p.year}: ${p.scanned} viestiä Saapuneissa`];
  for (const f of [...TARGETS, ...Object.keys(p.counts).filter((k) => k !== STAY && !(TARGETS as readonly string[]).includes(k))]) {
    if (!p.counts[f]) continue;
    lines.push(`• ${f}: ${p.counts[f]} (${(p.domains[f] ?? []).map(([d, n]) => `${d} ${n}`).join(", ")})`);
  }
  lines.push(`• Jää Saapuneisiin: ${p.counts[STAY]}`);
  if (looksOdd(p)) lines.push("Yli 60 % lähtisi Saapuneista: ei siirretä ennen tarkistusta");
  return lines.join("\n");
}

export interface MoveLog {
  year: number;
  id: string; // id before the move
  newId: string;
  from: string;
  to: string;
  at: string;
}

const readLines = <T>(file: string): T[] =>
  existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as T)
    : [];

export function savePlan(file: string, p: Plan) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(p), { mode: 0o600 });
}

export function loadPlan(file: string, now: Date): Plan {
  if (!existsSync(file)) throw new Error("no plan for that year: run plan first");
  const p = JSON.parse(readFileSync(file, "utf8")) as Plan;
  if (now.getTime() - Date.parse(p.at) > 24 * 3600000) throw new Error("the plan is over a day old: run plan again");
  return p;
}

const pause = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

/**
 * Moves a planned year in chunks, logging each move before the next chunk.
 * Stops after repeated errors. Returns moved and failed counts.
 */
export async function applyPlan(api: BacklogApi, p: Plan, logFile: string, now: () => Date, opts: { chunk?: number; delayMs?: number; maxErrorChunks?: number } = {}) {
  const forbidden = Object.values(await api.wellKnownFolderIds(["deleteditems", "junkemail", "sentitems", "drafts", "outbox"]));
  const folders = await api.listFolders();
  const ids: Record<string, string> = {};
  for (const name of new Set(p.items.map((i) => i.to))) {
    const f = folders.find((x) => x.displayName.toLowerCase() === name.toLowerCase()) ?? (await api.createFolder(name));
    if (forbidden.includes(f.id)) throw new Error(`refusing to move mail to ${name}`);
    ids[name] = f.id;
  }
  const done = new Set(readLines<MoveLog>(logFile).filter((l) => l.year === p.year).map((l) => l.id));
  const todo = p.items.filter((i) => !done.has(i.id));
  mkdirSync(dirname(logFile), { recursive: true });
  let moved = 0;
  let failed = 0;
  let errorChunks = 0;
  const size = opts.chunk ?? 20;
  for (let i = 0; i < todo.length; i += size) {
    const chunk = todo.slice(i, i + size);
    const res = await api.moveMany(chunk.map((c) => ({ id: c.id, folderId: ids[c.to] })));
    let bad = 0;
    for (const r of res) {
      const it = chunk.find((c) => c.id === r.id)!;
      if (r.newId) {
        appendFileSync(logFile, JSON.stringify({ year: p.year, id: r.id, newId: r.newId, from: STAY, to: it.to, at: now().toISOString() } satisfies MoveLog) + "\n", { mode: 0o600 });
        moved++;
      } else bad++;
    }
    failed += bad;
    errorChunks = bad > chunk.length / 2 ? errorChunks + 1 : 0;
    if (errorChunks >= (opts.maxErrorChunks ?? 3)) return { moved, failed, stopped: true, left: todo.length - i - chunk.length };
    if (opts.delayMs ?? 1500) await pause(opts.delayMs ?? 1500);
  }
  return { moved, failed, stopped: false, left: 0 };
}

/** Moves a year's logged moves back to the Inbox. */
export async function undoYear(api: BacklogApi, year: number, logFile: string, undoFile: string, opts: { chunk?: number; delayMs?: number } = {}) {
  const undone = new Set(readLines<{ newId: string }>(undoFile).map((l) => l.newId));
  const todo = readLines<MoveLog>(logFile).filter((l) => l.year === year && !undone.has(l.newId));
  const inbox = (await api.wellKnownFolderIds(["inbox"])).inbox;
  let back = 0;
  const size = opts.chunk ?? 20;
  for (let i = 0; i < todo.length; i += size) {
    const chunk = todo.slice(i, i + size);
    for (const r of await api.moveMany(chunk.map((c) => ({ id: c.newId, folderId: inbox })))) {
      if (!r.newId) continue;
      appendFileSync(undoFile, JSON.stringify({ newId: r.id, inboxId: r.newId }) + "\n", { mode: 0o600 });
      back++;
    }
    if (opts.delayMs ?? 1500) await pause(opts.delayMs ?? 1500);
  }
  return { back, of: todo.length };
}
