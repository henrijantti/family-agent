import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { dirname } from "node:path";
import type { MailMessage } from "./sources/outlook.js";

// Unsubscribes Henri from the newsletters he names (Henri, 2026-10-25), with
// code instead of a browser: the email agent reads untrusted mail, so it
// never opens links. Only RFC 8058 one-click is done automatically: a single
// POST of "List-Unsubscribe=One-Click" to the https address in the newest
// email's DKIM-signed List-Unsubscribe header. No cookies, no redirects, no
// page is rendered. Mailto unsubscribes would send mail, so they and plain
// web links are only listed for Henri to tap Unsubscribe in Outlook.

export type Method = "oneclick" | "mailto" | "link" | "none";

export interface PlanItem {
  needle: string;
  address: string;
  name: string;
  count: number;
  method: Method;
  /** The one-click https address (only for oneclick). */
  url?: string;
}
export interface Plan {
  at: string;
  folder: string;
  items: PlanItem[];
  /** Names Henri gave that matched no sender in the folder. */
  missing: string[];
}

const header = (m: MailMessage, name: string) =>
  (m.internetMessageHeaders ?? [])
    .filter((h) => h.name.toLowerCase() === name.toLowerCase())
    .map((h) => h.value)
    .join(", ");

/** Splits a List-Unsubscribe value into its <...> addresses. */
export function unsubTargets(value: string): string[] {
  return [...value.matchAll(/<([^>]+)>/g)].map((x) => x[1].trim());
}

/** How one email can be unsubscribed from, without a browser. */
export function method(m: MailMessage): { method: Method; url?: string } {
  const targets = unsubTargets(header(m, "List-Unsubscribe"));
  const https = targets.find((t) => /^https:\/\//i.test(t));
  const oneClick = /List-Unsubscribe\s*=\s*One-Click/i.test(header(m, "List-Unsubscribe-Post"));
  // RFC 8058 needs a valid DKIM signature over the header; Outlook records the check.
  const dkim = /\bdkim=pass\b/i.test(header(m, "Authentication-Results"));
  if (https && oneClick && dkim) return { method: "oneclick", url: https };
  if (targets.some((t) => /^mailto:/i.test(t))) return { method: "mailto" };
  if (https || targets.some((t) => /^http:\/\//i.test(t))) return { method: "link" };
  return { method: "none" };
}

/** Reads a list file: one sender name per line, # comments. */
export function readNeedles(file: string): string[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .map((l) => l.replace(/#.*/, "").trim())
    .filter(Boolean);
}

const norm = (s: string) => s.toLowerCase().normalize("NFC");

/** Groups the folder's mail by sender address and picks the newest email of each sender a needle names. */
export function makePlan(msgs: MailMessage[], needles: string[], folder: string, now: Date): Plan {
  const bySender = new Map<string, MailMessage[]>();
  for (const m of msgs) {
    const a = (m.from?.emailAddress.address ?? "").toLowerCase();
    if (a) (bySender.get(a) ?? bySender.set(a, []).get(a)!).push(m);
  }
  const items: PlanItem[] = [];
  const missing: string[] = [];
  for (const needle of needles) {
    const n = norm(needle);
    let hit = false;
    for (const [address, list] of bySender) {
      const names = list.map((m) => norm(m.from?.emailAddress.name ?? ""));
      if (!names.some((x) => x.includes(n)) && !address.includes(n)) continue;
      if (items.some((i) => i.address === address)) continue;
      hit = true;
      const newest = [...list].sort((a, b) => b.receivedDateTime.localeCompare(a.receivedDateTime))[0];
      items.push({ needle, address, name: newest.from?.emailAddress.name ?? address, count: list.length, ...method(newest) });
    }
    if (!hit) missing.push(needle);
  }
  return { at: now.toISOString(), folder, items, missing };
}

const LABEL: Record<Method, string> = {
  oneclick: "perutaan automaattisesti",
  mailto: "vaatii sähköpostin lähettämisen: napauta Outlookissa Peru tilaus",
  link: "vain verkkosivu: napauta Outlookissa Peru tilaus",
  none: "ei peruutuslinkkiä otsikoissa",
};

export function planReport(p: Plan): string {
  const lines = [`Kansio ${p.folder}: ${p.items.length} lähettäjää`];
  for (const m of ["oneclick", "mailto", "link", "none"] as Method[]) {
    const its = p.items.filter((i) => i.method === m);
    if (!its.length) continue;
    lines.push("", `${LABEL[m]} (${its.length}):`);
    for (const i of its) lines.push(`• ${i.name} <${i.address}>, ${i.count} viestiä (haku "${i.needle}")`);
  }
  if (p.missing.length) lines.push("", `Ei löytynyt kansiosta: ${p.missing.join(", ")}`);
  return lines.join("\n");
}

export function savePlan(file: string, p: Plan) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(p), { mode: 0o600 });
}

export function loadPlan(file: string, now: Date): Plan {
  if (!existsSync(file)) throw new Error("no plan: run plan first");
  const p = JSON.parse(readFileSync(file, "utf8")) as Plan;
  if (now.getTime() - Date.parse(p.at) > 24 * 3600000) throw new Error("the plan is over a day old: run plan again");
  return p;
}

const PRIVATE4 = /^(0|10|127|169\.254|172\.(1[6-9]|2\d|3[01])|192\.168|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7]))\./;
/** True for loopback, private, link-local, CGNAT (Tailscale) and other non-public addresses. */
export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) return PRIVATE4.test(ip) || ip.startsWith("0.");
  const v = ip.toLowerCase();
  if (v.startsWith("::ffff:")) return isPrivateAddress(v.slice(7));
  return v === "::" || v === "::1" || /^f[cd]/.test(v) || /^fe[89ab]/.test(v);
}

/** Refuses anything but https to a public host on the default port. */
export async function checkUrl(raw: string, resolve = async (h: string) => (await lookup(h, { all: true })).map((a) => a.address)): Promise<URL> {
  const u = new URL(raw);
  if (u.protocol !== "https:" || u.username || u.password || (u.port && u.port !== "443")) throw new Error("not a plain https address");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) || /(^|\.)(localhost|local|internal|ts\.net)$/i.test(host)) throw new Error("host is not a public name");
  const ips = await resolve(host);
  if (!ips.length || ips.some(isPrivateAddress)) throw new Error("host resolves to a private address");
  return u;
}

export type Poster = (url: URL) => Promise<number>;

/** The one-click POST itself: no cookies, no credentials, no redirects, 15 s limit. */
export const oneClickPost: Poster = async (url) => {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": "family-agent-unsubscribe" },
    body: "List-Unsubscribe=One-Click",
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
  await res.body?.cancel();
  return res.status;
};

export interface LogLine {
  address: string;
  status: number | string;
  ok: boolean;
  at: string;
}

const readLog = (file: string): LogLine[] =>
  existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as LogLine)
    : [];

/** POSTs each one-click item once (a logged success is not repeated); logs every attempt. */
export async function applyPlan(p: Plan, logFile: string, now: () => Date, post: Poster = oneClickPost, check = checkUrl) {
  const done = new Set(readLog(logFile).filter((l) => l.ok).map((l) => l.address));
  mkdirSync(dirname(logFile), { recursive: true });
  const results: { name: string; address: string; ok: boolean; status: number | string }[] = [];
  for (const i of p.items) {
    if (i.method !== "oneclick" || !i.url || done.has(i.address)) continue;
    let status: number | string;
    try {
      status = await post(await check(i.url));
    } catch (e) {
      status = (e as Error).message.slice(0, 120);
    }
    // RFC 8058 answers 2xx; a redirect is not followed, so it stays unconfirmed.
    const ok = typeof status === "number" && status >= 200 && status < 300;
    appendFileSync(logFile, JSON.stringify({ address: i.address, status, ok, at: now().toISOString() } satisfies LogLine) + "\n", { mode: 0o600 });
    results.push({ name: i.name, address: i.address, ok, status });
  }
  return results;
}

export function applyReport(p: Plan, results: Awaited<ReturnType<typeof applyPlan>>): string {
  const ok = results.filter((r) => r.ok);
  const bad = results.filter((r) => !r.ok);
  const manual = p.items.filter((i) => i.method !== "oneclick");
  const lines = [`Peruttu automaattisesti: ${ok.length}`];
  for (const r of ok) lines.push(`• ${r.name}`);
  if (bad.length) {
    lines.push("", `Epäonnistui (${bad.length}):`);
    for (const r of bad) lines.push(`• ${r.name}: ${r.status}`);
  }
  if (manual.length) {
    lines.push("", `Peru itse Outlookissa (${manual.length}):`);
    for (const i of manual) lines.push(`• ${i.name}: ${LABEL[i.method]}`);
  }
  return lines.join("\n");
}
