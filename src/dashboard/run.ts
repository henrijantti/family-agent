import { createHash } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { env } from "../config.js";
import { collectHub, familyChat, type Ctx } from "../jobs.js";
import { localParts } from "../lib/time.js";
import type { MyClubSnapshot } from "../sources/myclub.js";
import type { WilmaSnapshot } from "../sources/wilma.js";
import { dashboardModel, renderDashboard } from "./build.js";
import { screenshot } from "./shot.js";

// Keeps one pinned picture in the family group up to date. Every tick builds
// the page; only when its content differs from the last picture is it rendered
// and the pinned message edited in place (an edit notifies nobody). The first
// run, or a run after someone deleted the message, sends a new one and pins it.
//
// Optional HTML version: DASHBOARD_HTML_FILE is where the page is written on
// every change (the server serves it to the tailnet with `tailscale serve`),
// and DASHBOARD_URL puts an "Avaa HTML" button under the picture.

export type Shooter = (html: string) => Promise<Buffer>;

export async function buildDashboard(ctx: Ctx) {
  const events = await collectHub(ctx, 7);
  const model = dashboardModel({
    now: ctx.now,
    cfg: ctx.cfg,
    events,
    wilma: ctx.state.wilma.lastSnapshot as WilmaSnapshot | undefined,
    myclub: ctx.state.myclub.lastSnapshot as MyClubSnapshot | undefined,
    health: ctx.state.health,
  });
  const lp = localParts(ctx.now);
  const updated = `${["su", "ma", "ti", "ke", "to", "pe", "la"][new Date(`${lp.date}T12:00:00Z`).getUTCDay()]} ${lp.time}`;
  return {
    model,
    html: renderDashboard(model, ctx.cfg, updated),
    // The update time is left out, so an unchanged week makes no new picture.
    hash: createHash("sha256").update(renderDashboard(model, ctx.cfg)).digest("hex").slice(0, 16),
    updated,
  };
}

export async function runDashboard(ctx: Ctx, opts: { force?: boolean; shoot?: Shooter } = {}): Promise<"unchanged" | "edited" | "sent"> {
  const chat = familyChat();
  if (!chat || !ctx.notifier?.photo || !ctx.notifier.editPhoto) throw new Error("dashboard needs TELEGRAM_BOT_TOKEN and TELEGRAM_FAMILY_CHAT_ID");
  const d = await buildDashboard(ctx);
  const prev = ctx.state.dashboard?.chatId === chat ? ctx.state.dashboard : undefined;
  // A pin that failed (no admin right yet, a Telegram hiccup) is retried every run.
  if (prev && !prev.pinned) prev.pinned = await pin(ctx, chat, prev.messageId);
  if (!opts.force && prev?.hash === d.hash) return "unchanged";
  const png = await (opts.shoot ?? ((h) => screenshot(h)))(d.html);
  const file = env("DASHBOARD_HTML_FILE");
  if (file) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, d.html);
    renameSync(`${file}.tmp`, file); // never serve a half-written page
  }
  const url = env("DASHBOARD_URL");
  const link = url ? { text: "Avaa HTML", url } : undefined;
  const caption = `Perheen viikko · päivitetty ${d.updated}`;
  const at = ctx.now.toISOString();
  if (prev) {
    try {
      await ctx.notifier.editPhoto(chat, prev.messageId, png, caption, link);
      ctx.state.dashboard = { ...prev, hash: d.hash, at };
      ctx.log(`dashboard: updated pinned message ${prev.messageId}`);
      return "edited";
    } catch (e) {
      // Deleted or no longer editable: post a fresh one below.
      if (!/message to edit not found|message can't be edited|MESSAGE_ID_INVALID/i.test(String(e))) throw e;
      ctx.log(`dashboard: message ${prev.messageId} is gone, sending a new one`);
    }
  }
  const { messageId } = await ctx.notifier.photo(chat, png, caption, link);
  ctx.state.dashboard = { chatId: chat, messageId, hash: d.hash, at, pinned: await pin(ctx, chat, messageId) };
  ctx.log(`dashboard: sent message ${messageId}`);
  return "sent";
}

async function pin(ctx: Ctx, chat: string, messageId: number): Promise<boolean> {
  try {
    await ctx.notifier!.pin?.(chat, messageId);
    ctx.log(`dashboard: pinned message ${messageId}`);
    return true;
  } catch (e) {
    ctx.log(`dashboard: could not pin message ${messageId} (is the bot an admin with "Pin messages"?): ${e instanceof Error ? e.message : e}`);
    return false;
  }
}
