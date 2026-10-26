import { randomBytes } from "node:crypto";

// A calendar invitation email (Henri, 2026-10-26: option B): one event from the
// family calendars, sent from Henri's personal Outlook to his work address as a
// meeting request, so it lands in the work calendar and blocks the time there.
// Built here from calendar data only; the Email agent never writes its text.

export interface Invite {
  title: string;
  /** Timed: ISO with offset. All-day: YYYY-MM-DD. */
  start: string;
  /** Timed: ISO with offset. All-day: the day after the last day (exclusive), as Google stores it. */
  end: string;
  allDay: boolean;
  location?: string;
}

const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

/** RFC 5545 line folding: at most 75 octets a line, continuation lines start with a space. */
function fold(line: string): string {
  const out: string[] = [];
  let cur = "";
  let bytes = 0;
  for (const ch of line) {
    const n = Buffer.byteLength(ch);
    if (bytes + n > (out.length ? 74 : 75)) {
      out.push(cur);
      cur = "";
      bytes = 0;
    }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out.join("\r\n ");
}

const utc = (iso: string) => new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const day = (d: string) => d.replace(/-/g, "");

export function inviteIcs(inv: Invite, uid: string, organizer: string, attendee: string, now: Date): string {
  const when = inv.allDay
    ? [`DTSTART;VALUE=DATE:${day(inv.start)}`, `DTEND;VALUE=DATE:${day(inv.end)}`]
    : [`DTSTART:${utc(inv.start)}`, `DTEND:${utc(inv.end)}`];
  return (
    [
      "BEGIN:VCALENDAR",
      "PRODID:-//family-agent//work invite//FI",
      "VERSION:2.0",
      "CALSCALE:GREGORIAN",
      "METHOD:REQUEST",
      "BEGIN:VEVENT",
      `UID:${uid}`,
      `DTSTAMP:${utc(now.toISOString())}`,
      ...when,
      `SUMMARY:${esc(inv.title)}`,
      ...(inv.location ? [`LOCATION:${esc(inv.location)}`] : []),
      `ORGANIZER:mailto:${organizer}`,
      `ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=FALSE:mailto:${attendee}`,
      "SEQUENCE:0",
      "STATUS:CONFIRMED",
      `TRANSP:${inv.allDay ? "TRANSPARENT" : "OPAQUE"}`,
      "END:VEVENT",
      "END:VCALENDAR",
    ]
      .map(fold)
      .join("\r\n") + "\r\n"
  );
}

/** How the event reads to Henri: "ke 4.11. klo 18.00–19.00" or "ke 4.11." (Helsinki time). */
export function inviteWhen(inv: Invite): string {
  const fmt = (o: Intl.DateTimeFormatOptions, iso: string) => new Intl.DateTimeFormat("fi-FI", { timeZone: "Europe/Helsinki", ...o }).format(new Date(iso));
  if (inv.allDay) return fmt({ weekday: "short", day: "numeric", month: "numeric" }, `${inv.start}T12:00:00Z`);
  const t = (iso: string) => fmt({ hour: "2-digit", minute: "2-digit" }, iso);
  return `${fmt({ weekday: "short", day: "numeric", month: "numeric" }, inv.start)} klo ${t(inv.start)}–${t(inv.end)}`;
}

const b64 = (s: string) =>
  Buffer.from(s, "utf8")
    .toString("base64")
    .replace(/.{76}/g, "$&\r\n");

/** The whole email as MIME, the way calendar apps send invitations: text, the request itself, and an .ics copy. */
export function inviteMime(inv: Invite, uid: string, from: string, to: string, now: Date): { subject: string; mime: string; preview: string } {
  const subject = `Kutsu: ${inv.title}`;
  const text = [inv.title, inviteWhen(inv), ...(inv.location ? [inv.location] : []), "", "Lähetetty perhekalenterista."].join("\n");
  const ics = inviteIcs(inv, uid, from, to, now);
  const a = `mixed-${randomBytes(8).toString("hex")}`;
  const b = `alt-${randomBytes(8).toString("hex")}`;
  const mime = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: =?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${a}"`,
    "",
    `--${a}`,
    `Content-Type: multipart/alternative; boundary="${b}"`,
    "",
    `--${b}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    b64(text),
    `--${b}`,
    'Content-Type: text/calendar; charset=UTF-8; method=REQUEST; name="invite.ics"',
    "Content-Transfer-Encoding: base64",
    "",
    b64(ics),
    `--${b}--`,
    `--${a}`,
    'Content-Type: application/ics; name="invite.ics"',
    'Content-Disposition: attachment; filename="invite.ics"',
    "Content-Transfer-Encoding: base64",
    "",
    b64(ics),
    `--${a}--`,
    "",
  ].join("\r\n");
  return { subject, mime, preview: `${inviteWhen(inv)}${inv.location ? `, ${inv.location}` : ""}` };
}
