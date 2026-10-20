export type EventTime = { date: string } | { dateTime: string; timeZone?: string };

/** What a source wants on its calendar. */
export interface DesiredEvent {
  source: "wilma" | "myclub";
  sourceId: string;
  title: string;
  start: EventTime;
  end: EventTime;
  location?: string;
  description?: string;
  url?: string;
  tentative?: boolean;
  /** Popup reminder, minutes before start. Only on items that need action. */
  reminderMinutes?: number;
}

/** The subset of a Google Calendar event the agent reads and writes. */
export interface CalendarEvent {
  id: string;
  summary?: string;
  description?: string;
  location?: string;
  start: EventTime;
  end: EventTime;
  status?: "confirmed" | "tentative" | "cancelled";
  transparency?: "opaque" | "transparent";
  reminders?: { useDefault: boolean; overrides?: { method: "popup"; minutes: number }[] };
  extendedProperties?: { private?: Record<string, string> };
  source?: { title: string; url: string };
}

export interface ListOptions {
  timeMin: string;
  timeMax: string;
  privateExtendedProperty?: string;
  showDeleted?: boolean;
}

export interface CalendarApi {
  list(calendarId: string, opts: ListOptions): Promise<CalendarEvent[]>;
  insert(calendarId: string, event: CalendarEvent): Promise<CalendarEvent>;
  update(calendarId: string, eventId: string, event: CalendarEvent): Promise<CalendarEvent>;
  delete(calendarId: string, eventId: string): Promise<void>;
}

export class CalendarHttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
