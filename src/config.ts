import { readFileSync } from "node:fs";
import { parse } from "yaml";
import type { Day } from "./lib/time.js";

export interface RunSlot {
  days: Day[];
  time: string;
  alerts?: boolean;
  /** Wilma only: also send the week's summary per child (src/digest/wilma-week.ts). */
  weekly?: boolean;
}

export interface Child {
  name: string;
  match?: string[];
}

export interface Config {
  timezone: string;
  children: Child[];
  calendar: {
    family_calendar_id_env: string;
    school_calendar_id_env: string;
    hobbies_calendar_id_env: string;
    missing_runs_before_delete: number;
    max_deletes_per_run: number;
  };
  digest: {
    language: "en" | "fi";
    weekday_time: string;
    weekend_time: string;
    week_ahead: { day: Day; time: string };
    coming_up_days: number;
  };
  alerts: { quiet_hours: { from: string; to: string }; exam_soon_days: number };
  wilma: { enabled: boolean; include_grades: boolean; runs: RunSlot[]; bulletin_events: boolean };
  myclub: { enabled: boolean; runs: RunSlot[]; horizon_weeks: number; mode: "auto" | "ics" | "pages"; base_url: string };
  /** Pinned dashboard picture in the family group, refreshed by the tick when it changes. */
  dashboard?: { enabled: boolean; /** Henri's Drive file his Claude artifact shows. */ drive_file_id?: string };
  /** Jobs the OpenClaw agent runs instead of the tick (see openclaw/README.md). */
  agent_jobs?: string[];
  attendance?: { enabled: boolean; children: string[]; poll: RunSlot; apply: RunSlot; live: boolean; clubs?: { host: string; child: string }[] };
  outlook: {
    enabled: boolean;
    runs: RunSlot[];
    remind_days_before: number;
    bills_to: "family" | "private_if_set" | "none";
    scan_lookback_days: number;
    /** Move Wilma's notification emails out of the inbox into this folder. */
    wilma_folder?: { name: string; senders: string[] };
    /** The OpenClaw Email agent's tool server (src/agent/mail-tools.ts). */
    email_agent?: { send: boolean; self: string[] };
  };
}

export function loadConfig(path = process.env.FAMILY_AGENT_CONFIG ?? "config.yaml"): Config {
  const cfg = parse(readFileSync(path, "utf8")) as Config;
  cfg.children ??= [];
  return cfg;
}

/** Display name for a child as a source names them ("Aino Virtanen" -> "Aino"). */
export function childName(cfg: Config, sourceName: string): string {
  const lower = sourceName.toLowerCase();
  for (const c of cfg.children) {
    const keys = c.match?.length ? c.match : [c.name];
    if (keys.some((k) => lower.startsWith(k.toLowerCase()) || lower.includes(` ${k.toLowerCase()}`))) return c.name;
  }
  // Wilma lists "Lastname Firstname" on some tenants and "Firstname Lastname" on others;
  // without config, use the first word.
  return sourceName.trim().split(/\s+/)[0] || sourceName;
}

/** Secrets and ids come only from the environment. */
export function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : undefined;
}

export function requireEnv(name: string): string {
  const v = env(name);
  if (!v) throw new MissingSecretError(name);
  return v;
}

export class MissingSecretError extends Error {
  constructor(public secret: string) {
    super(`Missing secret ${secret}`);
  }
}

export const isMock = () => env("FAMILY_AGENT_MOCK") === "1";
