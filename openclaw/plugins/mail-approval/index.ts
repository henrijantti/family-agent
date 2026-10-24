import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

// Every mail_send call from the Email agent waits here for Henri. OpenClaw
// shows the approval card in Telegram (Allow once / Deny; no "always"), and
// only on Allow does this write the approval the mail tool server checks
// before sending (src/agent/mail-tools.ts). Without this plugin nothing can
// be sent, because that approval never appears.

const DEFAULT_STATE = "/home/openclaw/family-agent/state";

function draft(stateDir: string, draftId: string): { replyTo?: string; subject?: string; preview?: string } {
  const file = join(stateDir, "mail-drafts.jsonl");
  if (!existsSync(file)) return {};
  for (const l of readFileSync(file, "utf8").split("\n")) {
    if (!l) continue;
    const r = JSON.parse(l);
    if (r.draftId === draftId && r.messageId) return r;
  }
  return {};
}

export default definePluginEntry({
  id: "mail-approval",
  name: "Mail approval",
  register(api: any) {
    const stateDir: string = api.pluginConfig?.stateDir ?? DEFAULT_STATE;
    api.on("before_tool_call", async (event: any) => {
      // MCP tools may carry a server prefix (e.g. "mail__mail_send").
      if (!/(^|[_.:-])mail_send$/.test(String(event.toolName))) return;
      const draftId = String(event.params?.draftId ?? "");
      const d = draft(stateDir, draftId);
      // Henri reads this on his phone: who, what, and the start of the reply. No ids.
      const known = !!d.replyTo;
      return {
        requireApproval: {
          title: (known ? `📧 Lähetetäänkö vastaus: ${d.replyTo}?` : "📧 Ei lähetettävää luonnosta").slice(0, 80),
          description: (known
            ? `Aihe: ${d.subject || "(ei aihetta)"}\n\n${d.preview ?? ""}`
            : "Tätä luonnosta ei löytynyt, joten mitään ei lähetetä. Paina Deny.").slice(0, 512),
          severity: "warning",
          allowedDecisions: ["allow-once", "deny"],
          timeoutMs: 600_000,
          onResolution(decision: string) {
            appendFileSync(join(stateDir, "mail-approvals.jsonl"), JSON.stringify({ draftId, decision, at: new Date().toISOString() }) + "\n", { mode: 0o600 });
          },
        },
      };
    });
  },
});
