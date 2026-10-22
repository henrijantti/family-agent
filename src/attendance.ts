import type { Config } from "./config.js";
import { childName, env } from "./config.js";
import type { Ctx } from "./jobs.js";
import { addDays, dayOf, localParts } from "./lib/time.js";
import { esc } from "./notify/telegram.js";
import type { MyClubEvent, MyClubSnapshot } from "./sources/myclub.js";

// Weekly practice question: on Sunday the bot posts one Telegram poll per
// child with next week's MyClub events; on Monday morning the agent closes the
// polls, signs the ticked events up in MyClub and declines the rest, then
// posts what it did. No answers on a poll: nothing is changed for that child.

export interface PollOption {
  eventId: string;
  /** MyClub event page, e.g. https://ppj.myclub.fi/flow/events/123 (from the feed). */
  url?: string;
  label: string;
  date: string;
}

export interface AttendancePoll {
  child: string;
  chatId: string;
  messageId: number;
  postedAt: string;
  options: PollOption[];
  status: "open" | "applied" | "no-answer" | "superseded";
}

/** Signs a child up for, or out of, one MyClub event. Returns a short result. */
export interface AttendanceWriter {
  readonly live: boolean;
  set(option: PollOption, child: string, attend: boolean): Promise<string>;
}

/** Used until the MyClub sign-up step is verified against the real pages. */
export class DryRunWriter implements AttendanceWriter {
  readonly live = false;
  async set(_option: PollOption, _child: string, attend: boolean) {
    return attend ? "would sign up" : "would decline";
  }
}

const MAX_EVENTS = 9; // Telegram allows 10 poll options; one is "none of these"

const T = {
  en: {
    question: (c: string) => `Which practices will ${c} attend next week?`,
    none: "None of these",
    noAnswer: (c: string) => `Nobody answered ${c}'s practice poll, so nothing was changed in MyClub.`,
    title: (c: string) => `MyClub sign-ups for ${c}`,
    dry: "Not sent to MyClub yet: the sign-up step is still being set up.",
    more: (n: number) => `${n} more events didn't fit in the poll; answer those in MyClub.`,
  },
  fi: {
    question: (c: string) => `Mihin harjoituksiin ${c} osallistuu ensi viikolla?`,
    none: "Ei mihinkään näistä",
    noAnswer: (c: string) => `Kukaan ei vastannut ${/[aeiouyäö]$/i.test(c) ? `${c}n` : `${c}in`} kyselyyn, joten MyClubiin ei tehty muutoksia.`,
    title: (c: string) => `MyClub-ilmoittautumiset: ${c}`,
    dry: "Ei vielä lähetetty MyClubiin: ilmoittautumisvaihe on vielä asennuksessa.",
    more: (n: number) => `${n} tapahtumaa ei mahtunut kyselyyn; vastaa niihin MyClubissa.`,
  },
};

function eventDate(e: MyClubEvent) {
  return "date" in e.start ? e.start.date : localParts(new Date(e.start.dateTime)).date;
}

function eventTime(e: MyClubEvent) {
  return "date" in e.start ? "" : ` ${localParts(new Date(e.start.dateTime)).time}`;
}

/** Seven days of non-cancelled events for one child, from `start` (default tomorrow). */
export function weekEvents(snap: MyClubSnapshot, cfg: Config, child: string, now: Date, start?: string): MyClubEvent[] {
  const from = start ?? addDays(localParts(now).date, 1);
  const to = addDays(from, 6);
  return snap.events
    .filter((e) => e.child && childName(cfg, e.child) === child && !e.cancelled)
    .filter((e) => eventDate(e) >= from && eventDate(e) <= to)
    .sort((a, b) => (eventDate(a) + eventTime(a)).localeCompare(eventDate(b) + eventTime(b)));
}

export function optionLabel(e: MyClubEvent): string {
  const d = eventDate(e);
  const [, m, day] = d.split("-");
  return `${dayOf(d)} ${Number(day)}.${Number(m)}.${eventTime(e)} ${e.title}`.slice(0, 100);
}

const CLUB_NAMES: Record<string, string> = { ppj: "PPJ", "kiekko-espoo": "Kiekko-Espoo", viimahockey: "Viima" };

/**
 * Posts one poll per child and club. `start`: first day (default tomorrow).
 * `onlyClub`: add polls for that club alone, leaving the child's open polls as they are.
 */
export async function runAttendancePoll(ctx: Ctx, start?: string, onlyClub?: string) {
  const cfg = ctx.cfg.attendance;
  const chat = env("TELEGRAM_FAMILY_CHAT_ID");
  let snap = ctx.state.myclub.lastSnapshot as MyClubSnapshot | undefined;
  if (ctx.myclubInvites) {
    try {
      snap = await ctx.myclubInvites.fetch(ctx.cfg);
    } catch (e) {
      ctx.log(`attendance poll: MyClub invitations unavailable: ${(e as Error).message}`);
      if (chat) await ctx.notifier?.send(chat, esc("Couldn't read MyClub invitations, so no practice polls this week. Answer in MyClub directly."));
      return;
    }
  }
  if (!cfg?.enabled || !snap || !chat || !ctx.notifier?.poll) {
    ctx.log("attendance poll: skipped (needs attendance config, a MyClub snapshot, the family chat and Telegram)");
    return;
  }
  const t = T[ctx.cfg.digest.language] ?? T.en;
  const polls = (ctx.state.myclub.polls ??= []);
  for (const child of cfg.children) {
    const events = weekEvents(snap, ctx.cfg, child, ctx.now, start).filter((e) => !onlyClub || e.club === onlyClub);
    ctx.log(`attendance poll: ${child}: ${events.length} unanswered events in the 7 days from ${start ?? "tomorrow"}${onlyClub ? ` (${onlyClub})` : ""}`);
    if (!events.length) continue;
    if (!onlyClub) for (const p of polls) if (p.child === child && p.status === "open") p.status = "superseded";
    const byClub = new Map<string, MyClubEvent[]>();
    for (const e of events) byClub.set(e.club ?? "", [...(byClub.get(e.club ?? "") ?? []), e]);
    for (const [club, evs] of byClub) {
      const label = club && (byClub.size > 1 || onlyClub) ? ` (${CLUB_NAMES[club] ?? club})` : "";
      const shown = evs.slice(0, MAX_EVENTS);
      const options = shown.map((e) => ({ eventId: e.id, url: e.url, label: optionLabel(e), date: eventDate(e) }));
      const { messageId } = await ctx.notifier.poll(chat, `${t.question(child)}${label}`, [...options.map((o) => o.label), t.none]);
      polls.push({ child, chatId: chat, messageId, postedAt: ctx.now.toISOString(), options, status: "open" });
      if (evs.length > shown.length) await ctx.notifier.send(chat, esc(t.more(evs.length - shown.length)));
    }
  }
  ctx.state.myclub.polls = polls.filter((p) => Date.parse(p.postedAt) > ctx.now.getTime() - 35 * 86400000);
}

export async function runAttendanceApply(ctx: Ctx, writer: AttendanceWriter = new DryRunWriter()) {
  if (!ctx.notifier?.stopPoll) return;
  const t = T[ctx.cfg.digest.language] ?? T.en;
  for (const p of ctx.state.myclub.polls ?? []) {
    if (p.status !== "open") continue;
    const votes = await ctx.notifier.stopPoll(p.chatId, p.messageId);
    if (!votes.some((v) => v > 0)) {
      p.status = "no-answer";
      await ctx.notifier.send(p.chatId, esc(t.noAnswer(p.child)));
      continue;
    }
    const lines: string[] = [];
    const declined = new Set(ctx.state.myclub.declined ?? []);
    for (const [i, o] of p.options.entries()) {
      const attend = (votes[i] ?? 0) > 0;
      let result: string;
      try {
        result = await writer.set(o, p.child, attend);
      } catch (e) {
        result = `failed: ${(e as Error).message}`;
      }
      if (attend) declined.delete(o.eventId);
      else declined.add(o.eventId);
      lines.push(`${attend ? "✅" : "➖"} ${esc(o.label)} <i>(${esc(result)})</i>`);
    }
    ctx.state.myclub.declined = [...declined].slice(-200);
    p.status = "applied";
    await ctx.notifier.send(p.chatId, `<b>${esc(t.title(p.child))}</b>\n${lines.join("\n")}${writer.live ? "" : `\n<i>${esc(t.dry)}</i>`}`);
  }
}
