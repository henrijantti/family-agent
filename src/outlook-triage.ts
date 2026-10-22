import { detectInvoice, htmlToText, type MailMessage } from "./sources/outlook.js";

// One-off sweep of Henri's inbox: labels invoices, unsubscribe candidates and
// important mail with Outlook categories. Invoices and important mail also
// get a follow-up flag; newsletters only get the label, so the flag list
// stays useful. Nothing is moved, deleted, unsubscribed or sent.

export type Kind = "invoice" | "newsletter" | "important";

export const CATEGORIES: Record<Kind, { name: string; color: string; flag: boolean }> = {
  invoice: { name: "Lasku", color: "preset0", flag: true },
  important: { name: "Tärkeä", color: "preset4", flag: true },
  newsletter: { name: "Peru tilaus?", color: "preset7", flag: false },
};

const header = (m: MailMessage, name: string) => m.internetMessageHeaders?.find((h) => h.name.toLowerCase() === name)?.value;
const text = (m: MailMessage) => (m.body ? (m.body.contentType === "html" ? htmlToText(m.body.content) : m.body.content) : m.bodyPreview ?? "");

const BULK_SENDER = /(no-?reply|noreply|newsletter|uutiskirje|news@|info@|marketing|mailer|campaign|offers|tarjous|hello@|notifications?@|updates?@)/i;
const UNSUB_TEXT = /(unsubscribe|peruuta tilaus|peru tilaus|tilauksen peruminen|lopeta tilaus|en halua vastaanottaa|manage (your )?(email )?preferences|uutiskirjeen tilaus|opt[- ]out)/i;
const IMPORTANT_WORDS = /\b(muistutus|maksumuistutus|perintä|karhu\w*|määräaika|viimeistään|deadline|urgent|kiireellinen|tärkeä|action required|toimenpiteitä|sopimus\w*|irtisano\w*|päätös|verotus|veropäätös|vakuutus\w*|ajanvaraus|tapaaminen|kokous|kutsu|security alert|tietoturva|password|salasana)\b/i;
const PERSONAL_DOMAINS = /^(gmail\.com|googlemail\.com|outlook\.com|hotmail\.\w+|live\.\w+|msn\.com|icloud\.com|me\.com|yahoo\.\w+|luukku\.com|kolumbus\.fi|elisanet\.fi|welho\.com|pp\.inet\.fi|saunalahti\.fi)$/i;
const AUTHORITY_DOMAINS = /(vero\.fi|kela\.fi|suomi\.fi|espoo\.fi|poliisi\.fi|traficom\.fi|migri\.fi|dvv\.fi|tyomarkkinatori\.fi)$/i;

export function isNewsletter(m: MailMessage): boolean {
  if (header(m, "list-unsubscribe") || /bulk|list/i.test(header(m, "precedence") ?? "")) return true;
  const from = m.from?.emailAddress.address ?? "";
  return BULK_SENDER.test(from) && UNSUB_TEXT.test(text(m));
}

export function classify(m: MailMessage, skipDomains: string[] = []): Kind | null {
  const from = (m.from?.emailAddress.address ?? "").toLowerCase();
  if (skipDomains.some((d) => from.endsWith(d))) return null;
  if (detectInvoice(m)) return "invoice";
  const domain = from.split("@")[1] ?? "";
  if (AUTHORITY_DOMAINS.test(domain)) return "important";
  if (isNewsletter(m)) return "newsletter";
  if (m.importance === "high") return "important";
  // Mail from a person, a reply in a conversation, or mail whose subject asks for action.
  if (PERSONAL_DOMAINS.test(domain) && !BULK_SENDER.test(from)) return "important";
  if (/^(re|vs|vast|sv|aw|fw|fwd|vl)\s*:/i.test(m.subject ?? "")) return "important";
  if (IMPORTANT_WORDS.test(m.subject ?? "")) return "important";
  return null;
}

export interface TriageApi {
  listInbox(sinceIso: string, max: number): Promise<MailMessage[]>;
  label(id: string, categories: string[], flag: boolean): Promise<void>;
  ensureCategories(cats: { name: string; color: string }[]): Promise<void>;
}

export interface TriageResult {
  scanned: number;
  labelled: Record<Kind, MailMessage[]>;
  skipped: number; // already labelled earlier
}

export async function triage(api: TriageApi, sinceIso: string, opts: { max: number; apply: boolean; skipDomains?: string[] }): Promise<TriageResult> {
  const msgs = await api.listInbox(sinceIso, opts.max);
  const labelled: Record<Kind, MailMessage[]> = { invoice: [], newsletter: [], important: [] };
  let skipped = 0;
  if (opts.apply) await api.ensureCategories(Object.values(CATEGORIES));
  for (const m of msgs) {
    const kind = classify(m, opts.skipDomains);
    if (!kind) continue;
    labelled[kind].push(m);
    const cat = CATEGORIES[kind];
    if (m.categories?.includes(cat.name)) {
      skipped++;
      continue;
    }
    if (opts.apply) {
      const flag = cat.flag && m.flag?.flagStatus !== "complete";
      await api.label(m.id, [...(m.categories ?? []), cat.name], flag).catch((e) => console.warn(`could not label a message: ${(e as Error).message}`));
    }
  }
  return { scanned: msgs.length, labelled, skipped };
}

/** Plain-text report: who sends the newsletters, and the invoices and important mail by date. */
export function triageReport(r: TriageResult): string {
  const who = (m: MailMessage) => m.from?.emailAddress.name || m.from?.emailAddress.address || "?";
  const day = (m: MailMessage) => m.receivedDateTime.slice(0, 10);
  const lines = [`Scanned ${r.scanned} inbox messages. Invoices ${r.labelled.invoice.length}, unsubscribe candidates ${r.labelled.newsletter.length}, important ${r.labelled.important.length}.`];
  const bySender = new Map<string, { name: string; n: number; last: string }>();
  for (const m of r.labelled.newsletter) {
    const addr = (m.from?.emailAddress.address ?? "?").toLowerCase();
    const e = bySender.get(addr) ?? { name: who(m), n: 0, last: day(m) };
    e.n++;
    bySender.set(addr, e);
  }
  lines.push("", "== Unsubscribe candidates (sender, address, messages) ==");
  for (const [addr, e] of [...bySender].sort((a, b) => b[1].n - a[1].n)) lines.push(`${e.n}\t${e.name}\t${addr}\tlatest ${e.last}`);
  lines.push("", "== Invoices ==");
  for (const m of r.labelled.invoice) {
    const b = detectInvoice(m)!;
    lines.push(`${day(m)}\t${b.biller}\t${b.amount ?? "?"}\tdue ${b.dueDate ?? "?"}\t${m.subject}`);
  }
  lines.push("", "== Important ==");
  for (const m of r.labelled.important) lines.push(`${day(m)}\t${who(m)}\t${m.subject}`);
  return lines.join("\n");
}
