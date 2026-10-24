import type { AgentPoll, AttendancePoll } from "../attendance.js";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// One JSON document holding everything that must survive between runs: ids
// already seen, the Wilma session, the rotated Outlook refresh token, the bill
// list, recent calendar changes. In GitHub Actions it lives on the `state`
// branch, encrypted with STATE_KEY, so the repo never holds readable data.

export interface ChangeRecord {
  at: string; // ISO time
  source: string;
  kind: "new" | "changed" | "cancelled";
  title: string;
  when: string; // human readable local date/time of the event
}

export interface Bill {
  messageId: string;
  biller: string;
  sender: string;
  amount?: string;
  dueDate?: string; // YYYY-MM-DD
  reference?: string;
  subject: string;
  newBiller: boolean;
  foundAt: string;
  remindedOn?: string[];
}

export interface StateData {
  version: 1;
  lastRun: Record<string, string>; // job -> local date+slot key
  changes: ChangeRecord[];
  health: Record<string, { ok: boolean; at: string; error?: string; lastCount?: number }>;
  wilma: {
    session?: string;
    seenMessages: number[];
    seenNews: number[];
    seenNotes: string[];
    exams: Record<string, string>; // examId -> date
    lastSnapshot?: unknown;
  };
  myclub: {
    lastSnapshot?: unknown;
    session?: string;
    /** Weekly practice polls (see attendance.ts). */
    polls?: AttendancePoll[];
    /** The OpenClaw agent's weekly attendance question: events offered per child and the answers given. */
    agentPoll?: AgentPoll;
    /** MyClub event ids the family said a child will skip. */
    declined?: string[];
  };
  outlook: { refreshToken?: string; lastScan?: string; bills: Bill[]; knownBillers: string[] };
  /** Wilma items found since the last digest, consumed by the next digest. */
  digestQueue: { child: string; kind: "message" | "bulletin" | "note"; text: string; action: boolean }[];
  lastDigestAt?: string;
}

export function emptyState(): StateData {
  return {
    version: 1,
    lastRun: {},
    changes: [],
    health: {},
    wilma: { seenMessages: [], seenNews: [], seenNotes: [], exams: {} },
    myclub: {},
    outlook: { bills: [], knownBillers: [] },
    digestQueue: [],
  };
}

const MAGIC = "FAENC1:";

function key(secret: string) {
  return createHash("sha256").update(secret).digest();
}

export function encrypt(plain: string, secret: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(secret), iv);
  const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return MAGIC + Buffer.concat([iv, c.getAuthTag(), body]).toString("base64");
}

export function decrypt(blob: string, secret: string): string {
  const raw = Buffer.from(blob.slice(MAGIC.length), "base64");
  const d = createDecipheriv("aes-256-gcm", key(secret), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
}

export class StateStore {
  data: StateData;
  constructor(
    private path: string,
    private secret?: string,
  ) {
    this.data = this.load();
  }

  private load(): StateData {
    if (!existsSync(this.path)) return emptyState();
    let text = readFileSync(this.path, "utf8");
    if (text.startsWith(MAGIC)) {
      if (!this.secret) throw new Error("State file is encrypted but STATE_KEY is not set");
      text = decrypt(text, this.secret);
    }
    return { ...emptyState(), ...JSON.parse(text) };
  }

  save() {
    mkdirSync(dirname(this.path), { recursive: true });
    // Keep the change log short: the digest only needs the last few days.
    const cutoff = Date.now() - 8 * 86400000;
    this.data.changes = this.data.changes.filter((c) => Date.parse(c.at) > cutoff);
    const json = JSON.stringify(this.data, null, 2);
    writeFileSync(this.path, this.secret ? encrypt(json, this.secret) : json);
  }
}
