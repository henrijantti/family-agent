// Reads payment details out of a PDF bill: amount, due date, IBAN and
// reference. Read-only, and it hands back those fields only, never the PDF's
// text: a PDF is written by whoever sent the email, so its words must not reach
// an agent as text (they could carry instructions). Every field is checked
// against a strict format, and IBAN and reference against their check digits,
// so a field can't smuggle free text either.
//
// Finnish bills usually print a "virtuaaliviivakoodi" (virtual bar code, 54
// digits) that holds account, amount, reference and due date in one checked
// string; when it's there it wins over the printed labels.

export interface BillFields {
  amount?: string; // "84.20"
  currency?: "EUR";
  due?: string; // YYYY-MM-DD
  iban?: string; // no spaces, e.g. FI2112345600000785
  reference?: string; // no spaces: Finnish (digits) or RF creditor reference
  source: "barcode" | "text";
}

export type PdfRead = { ok: true; fields: BillFields; missing: string[]; pages: number } | { ok: false; unreadable: "password" | "no_text" | "too_big" | "broken" | "timeout" };

export const MAX_PDF_BYTES = 5_000_000;
const MAX_PAGES = 4;
const TIMEOUT_MS = 20_000;

// ---------------------------------------------------------------- checks

/** ISO 13616 mod-97 check of an IBAN (spaces ignored). */
export function validIban(raw: string): boolean {
  const s = raw.replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s) || s.startsWith("RF")) return false;
  if (s.startsWith("FI") && s.length !== 18) return false;
  return mod97(s.slice(4) + s.slice(0, 4)) === 1;
}

function mod97(s: string): number {
  let r = 0;
  for (const ch of s) {
    const v = /\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
    for (const d of v) r = (r * 10 + Number(d)) % 97;
  }
  return r;
}

/** Finnish reference (viitenumero, 4-20 digits, 7-3-1 check digit) or RF creditor reference (ISO 11649). */
export function validReference(raw: string): boolean {
  const s = raw.replace(/\s+/g, "").toUpperCase();
  if (/^RF\d{2}[A-Z0-9]{1,21}$/.test(s)) return mod97(s.slice(4) + s.slice(0, 4)) === 1;
  if (!/^\d{4,20}$/.test(s)) return false;
  const body = s.slice(0, -1).replace(/^0+/, "");
  if (body.length < 3) return false;
  const w = [7, 3, 1];
  let sum = 0;
  [...body].reverse().forEach((d, i) => (sum += Number(d) * w[i % 3]));
  return (10 - (sum % 10)) % 10 === Number(s.slice(-1));
}

const realDate = (y: number, m: number, d: number) => {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d && y >= 2000 && y <= 2099;
};
const iso = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

// ---------------------------------------------------------------- bar code

/** Fields from a Finnish virtual bar code (version 4: national reference, 5: RF reference). */
export function parseBarcode(code: string): Omit<BillFields, "source"> | undefined {
  if (!/^[45]\d{53}$/.test(code)) return undefined;
  const iban = `FI${code.slice(1, 17)}`;
  if (!validIban(iban)) return undefined;
  const euros = Number(code.slice(17, 23));
  const cents = code.slice(23, 25);
  let reference: string;
  if (code[0] === "4") {
    if (code.slice(25, 28) !== "000") return undefined;
    reference = code.slice(28, 48).replace(/^0+/, "");
  } else {
    reference = `RF${code.slice(25, 27)}${code.slice(27, 48).replace(/^0+/, "")}`;
  }
  if (!validReference(reference)) return undefined;
  const yy = Number(code.slice(48, 50));
  const mm = Number(code.slice(50, 52));
  const dd = Number(code.slice(52, 54));
  const out: Omit<BillFields, "source"> = { iban, reference, currency: "EUR" };
  if (euros || Number(cents)) out.amount = `${euros}.${cents}`;
  if (code.slice(48) !== "000000" && realDate(2000 + yy, mm, dd)) out.due = iso(2000 + yy, mm, dd);
  return out;
}

// ---------------------------------------------------------------- text

const AMOUNT = /(?<![\d,.])(\d{1,3}(?:[  .]\d{3})+|\d{1,7})[,.](\d{2})(?![\d])/g;
const DATE = /(?<!\d)(\d{1,2})\.\s?(\d{1,2})\.\s?(\d{4}|\d{2})(?!\d)|(?<!\d)(20\d{2})-(\d{2})-(\d{2})(?!\d)/;

// Strongest label first: "Maksettava yhteensä" beats a line-item "Summa".
const AMOUNT_LABELS = [
  /maksettava(?:\s+(?:yhteensä|määrä|summa))?|att\s+betala|amount\s+due|total\s+due|to\s+pay/i,
  /yhteensä|loppusumma|totalt|summa\s+yhteensä|total/i,
  /\beuro\b|\beur\b|summa|määrä|belopp|amount/i,
];
const DUE_LABEL = /eräpäivä|förfallodag|erääntyy|erääntymispäivä|maksettava\s+viimeistään|maksa\s+viimeistään|due\s+date|payment\s+due|maksupäivä/i;
const REF_LABEL = /viitenumero|viite|ref\.?\s*nr|referens|reference|\bref\b/i;
// "RF" is a creditor reference, which uses the same mod-97 check, not a country.
const IBAN_RE = /\b((?!RF)[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){2,7}(?:\s?[A-Z0-9]{1,4})?)\b/g;

function amountIn(s: string): string | undefined {
  // Dates first out: "Maksettava viimeistään 27.10.2026" holds no amount.
  const all = [...s.replace(new RegExp(DATE.source, "g"), " ").matchAll(AMOUNT)];
  // The last figure on a label line is the total ("Yhteensä 3 kpl 84,20").
  const m = all[all.length - 1];
  if (!m) return undefined;
  const euros = Number(m[1].replace(/[  .]/g, ""));
  if (!Number.isFinite(euros) || euros > 9_999_999) return undefined;
  return `${euros}.${m[2]}`;
}

function dateIn(s: string): string | undefined {
  const m = s.match(DATE);
  if (!m) return undefined;
  const [y, mo, d] = m[1] ? [m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]), Number(m[2]), Number(m[1])] : [Number(m[4]), Number(m[5]), Number(m[6])];
  return realDate(y, mo, d) ? iso(y, mo, d) : undefined;
}

function referenceIn(s: string): string | undefined {
  // "RF18 5390 0754 7034 Euro 1 084,20": try the longest run of groups first, so a
  // neighbouring column's word or number can't hide the reference or shorten it.
  const tok = s.replace(IBAN_RE, " ").split(/\s+/).filter(Boolean);
  for (let i = 0; i < tok.length; i++)
    for (let j = Math.min(tok.length, i + 7); j > i; j--) {
      const ref = tok.slice(i, j).join("").toUpperCase();
      if (/^(RF\d{2}[A-Z0-9]{1,21}|\d{4,20})$/.test(ref) && validReference(ref)) return ref;
    }
}

/** A label line's value is on the same line after the label, or on the next line (bank transfer form boxes). */
function afterLabel(lines: string[], label: RegExp, pick: (s: string) => string | undefined): string | undefined {
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(label);
    if (!m) continue;
    const rest = lines[i].slice(m.index! + m[0].length);
    // Only an empty box looks below: "Viite 1233" with a bad check digit must not borrow the next line's numbers.
    const v = pick(rest) ?? (!/\d/.test(rest) && i + 1 < lines.length ? pick(lines[i + 1]) : undefined);
    if (v) return v;
  }
}

/** Fields from the PDF's text lines. Exported for tests. */
export function parseBillText(text: string): BillFields {
  const lines = text.split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
  for (const l of [...lines, text.replace(/\s+/g, "")]) {
    for (const m of l.replace(/\s+/g, "").matchAll(/(?<!\d)[45]\d{53}(?!\d)/g)) {
      const bc = parseBarcode(m[0]);
      if (bc) return { ...bc, source: "barcode" };
    }
  }
  const out: BillFields = { source: "text" };
  for (const label of AMOUNT_LABELS) {
    out.amount = afterLabel(lines, label, amountIn);
    if (out.amount) break;
  }
  out.due = afterLabel(lines, DUE_LABEL, dateIn);
  out.reference = afterLabel(lines, REF_LABEL, referenceIn);
  for (const m of text.matchAll(IBAN_RE)) {
    if (validIban(m[1])) {
      out.iban = m[1].replace(/\s+/g, "");
      break;
    }
  }
  if (out.amount && (/€|\beur\b|euro/i.test(text) || out.iban?.startsWith("FI"))) out.currency = "EUR";
  for (const k of Object.keys(out) as (keyof BillFields)[]) if (out[k] === undefined) delete out[k];
  return out;
}

// ---------------------------------------------------------------- PDF

/** The PDF's text as lines, rebuilt from positioned text items (top to bottom, left to right). */
export async function pdfLines(bytes: Uint8Array): Promise<{ text: string; pages: number }> {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // No eval (CVE-2024-4367), no font loading, no network: text extraction only.
  const task = getDocument({ data: bytes, isEvalSupported: false, disableFontFace: true, useSystemFonts: false, stopAtErrors: false, verbosity: 0 });
  try {
    const doc = await task.promise;
    const out: string[] = [];
    for (let p = 1; p <= Math.min(doc.numPages, MAX_PAGES); p++) {
      const page = await doc.getPage(p);
      const rows = new Map<number, { x: number; s: string }[]>();
      for (const it of (await page.getTextContent()).items as { str?: string; transform?: number[] }[]) {
        if (!it.str?.trim() || !it.transform) continue;
        const y = Math.round(it.transform[5] / 3) * 3; // items within ~3 pt share a line
        rows.set(y, [...(rows.get(y) ?? []), { x: it.transform[4], s: it.str }]);
      }
      for (const y of [...rows.keys()].sort((a, b) => b - a))
        out.push(
          rows
            .get(y)!
            .sort((a, b) => a.x - b.x)
            .map((r) => r.s)
            .join(" "),
        );
    }
    return { text: out.join("\n").slice(0, 40_000), pages: doc.numPages };
  } finally {
    await task.destroy();
  }
}

export async function readBillPdf(bytes: Uint8Array): Promise<PdfRead> {
  if (bytes.byteLength > MAX_PDF_BYTES) return { ok: false, unreadable: "too_big" };
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_, rej) => (timer = setTimeout(() => rej(new Error("timeout")), TIMEOUT_MS)));
    const { text, pages } = await Promise.race([pdfLines(bytes), timeout]);
    if (text.replace(/\s/g, "").length < 20) return { ok: false, unreadable: "no_text" };
    const fields = parseBillText(text);
    const missing = (["amount", "due", "iban", "reference"] as const).filter((k) => !fields[k]);
    return { ok: true, fields, missing, pages };
  } catch (e) {
    const err = e as Error;
    if (err.name === "PasswordException") return { ok: false, unreadable: "password" };
    if (err.message === "timeout") return { ok: false, unreadable: "timeout" };
    return { ok: false, unreadable: "broken" };
  } finally {
    clearTimeout(timer);
  }
}
