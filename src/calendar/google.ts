import { createSign } from "node:crypto";
import { requireEnv } from "../config.js";
import { CalendarApi, CalendarEvent, CalendarHttpError, ListOptions } from "./types.js";

// Google Calendar through a service account: no passwords and no personal
// tokens. The account only reaches calendars that were shared with its address.

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

const SCOPE = "https://www.googleapis.com/auth/calendar.events";
const API = "https://www.googleapis.com/calendar/v3";

export function parseServiceAccountKey(raw: string): ServiceAccountKey {
  const text = raw.trim().startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8");
  const key = JSON.parse(text) as ServiceAccountKey;
  if (!key.client_email || !key.private_key) throw new Error("GOOGLE_SA_KEY is not a service account JSON key");
  return key;
}

function b64url(s: string | Buffer) {
  return Buffer.from(s).toString("base64url");
}

/** An access token for the service account (JWT bearer grant), for one scope. */
export async function serviceAccountToken(key: ServiceAccountKey, scope: string): Promise<{ value: string; exp: number }> {
  const now = Math.floor(Date.now() / 1000);
  const aud = key.token_uri ?? "https://oauth2.googleapis.com/token";
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({ iss: key.client_email, scope, aud, iat: now, exp: now + 3600 }));
  const sig = createSign("RSA-SHA256").update(`${header}.${claims}`).sign(key.private_key);
  const res = await fetch(aud, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${header}.${claims}.${b64url(sig)}`,
    }),
  });
  if (!res.ok) throw new CalendarHttpError(res.status, `Google token: ${await res.text()}`);
  const j = (await res.json()) as { access_token: string; expires_in: number };
  return { value: j.access_token, exp: Date.now() + j.expires_in * 1000 };
}

export class GoogleCalendar implements CalendarApi {
  private token?: { value: string; exp: number };
  constructor(private key: ServiceAccountKey) {}

  static fromEnv() {
    return new GoogleCalendar(parseServiceAccountKey(requireEnv("GOOGLE_SA_KEY")));
  }

  get email() {
    return this.key.client_email;
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.exp > Date.now() + 60_000) return this.token.value;
    this.token = await serviceAccountToken(this.key, SCOPE);
    return this.token.value;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { authorization: `Bearer ${await this.accessToken()}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new CalendarHttpError(res.status, `Google ${method} ${path.split("?")[0]}: ${res.status} ${await res.text()}`);
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  async list(calendarId: string, opts: ListOptions): Promise<CalendarEvent[]> {
    const out: CalendarEvent[] = [];
    let pageToken: string | undefined;
    do {
      const q = new URLSearchParams({
        timeMin: opts.timeMin,
        timeMax: opts.timeMax,
        singleEvents: "true",
        maxResults: "250",
        showDeleted: String(!!opts.showDeleted),
      });
      if (opts.privateExtendedProperty) q.set("privateExtendedProperty", opts.privateExtendedProperty);
      if (pageToken) q.set("pageToken", pageToken);
      const page = await this.call<{ items: CalendarEvent[]; nextPageToken?: string }>(
        "GET",
        `/calendars/${encodeURIComponent(calendarId)}/events?${q}`,
      );
      out.push(...(page.items ?? []));
      pageToken = page.nextPageToken;
    } while (pageToken);
    return out;
  }

  insert(calendarId: string, event: CalendarEvent) {
    return this.call<CalendarEvent>("POST", `/calendars/${encodeURIComponent(calendarId)}/events`, event);
  }

  update(calendarId: string, eventId: string, event: CalendarEvent) {
    return this.call<CalendarEvent>("PUT", `/calendars/${encodeURIComponent(calendarId)}/events/${eventId}`, event);
  }

  async delete(calendarId: string, eventId: string) {
    await this.call<void>("DELETE", `/calendars/${encodeURIComponent(calendarId)}/events/${eventId}`);
  }
}
