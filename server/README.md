# Family agent server

Scripts and config to rebuild the OpenClaw server (UpCloud, Ubuntu 26.04,
Helsinki) from scratch. Nothing here contains secrets.

## Rebuild order

1. Create the server, join it to the tailnet: `tailscale up --ssh`.
2. Copy this folder to the server and, over Tailscale SSH as root, run
   `bash 00-base-hardening.sh`. Check access as it says, then cancel the rollback timer.
3. Put the Anthropic API key on the server by hand (never in this repo):
   `/home/openclaw/.secrets/anthropic.env` with one line `ANTHROPIC_API_KEY=sk-ant-...`,
   owner `openclaw`, mode 600, folder mode 700.
4. Run `bash setup-openclaw.sh`. It also generates the gateway token in
   `/home/openclaw/.secrets/gateway.env`.
5. Enable HTTPS Certificates for the tailnet (Tailscale admin > DNS) if the
   script reports the `tailscale serve` step as skipped, then re-run it.

## Files

| File | Goes to |
| --- | --- |
| `00-base-hardening.sh` | Updates, swap, Docker, ufw, sshd lock-down |
| `setup-openclaw.sh` | Node, rootless Docker, OpenClaw, sandbox image, service, tailscale serve |
| `openclaw.json5` | `/home/openclaw/.openclaw/openclaw.json` |
| `openclaw-install-policy` | `/usr/local/bin/openclaw-install-policy` (blocks all skill/plugin installs) |
| `systemd/openclaw-gateway.service` | `/home/openclaw/.config/systemd/user/` (user unit, lingering on) |
| `family-agent-run.sh` | `/home/openclaw/family-agent-run.sh`: runs the agent CLI with secrets from `~/.secrets/family-agent/` |
| `systemd/family-agent-tick.service` + `.timer` | user units; a tick every 15 min (replaced GitHub's tick.yml on 2026-10-23) |
| `family-agent-backup.sh` | `/home/openclaw/family-agent-backup.sh`: nightly encrypted backup |
| `systemd/family-agent-backup.service` + `.timer` | user units; backup at 02:30 Helsinki |
| `family-agent-health.sh` + `systemd/family-agent-health.*` | every 10 min: private Telegram alert (Chief of staff bot, chat id in `~/.secrets/health-chat-id`) when the tick, gateway, backup, a cron, memory or disk fails; once per problem per 6 h |
| `family-agent-status.sh` + `systemd/family-agent-status.*` | every 15 min: `status.json` (units, crons, memory, disk, open alerts; no secrets or content) to the `status` branch of the backup repo, for cloud sessions |
| `systemd/claude-remote-control.service` | user unit: Claude Code Remote Control as "family-agent server" in `~/family-agent` (live jobs checkout), restarts after 30 s; since 2026-10-25 |
| `email-agent.patch.json5` | `openclaw config patch --file`: agent `email`, `mail` MCP server, tool policy |
| `email-telegram.patch.json5` | `openclaw config patch --file`: the mail bot (DM allowlist), then `agents bind --agent email --bind telegram:mail` |
| `email-approvals.patch.json5` | `openclaw config patch --file`: route the mail-approval cards to Henri's mail-bot DM (approver + inline buttons) |
| `henri-agent.patch.json5` | `openclaw config patch --file`: agent `henri`, the assistant bot, `family` MCP server, tool denies for the other agents |
| `cos-desk.patch.json5` | `openclaw config patch --file`: `henri` becomes "Chief of staff", `desk` MCP server (mail desk), denies for the others |
| `family-agent.patch.json5` | `openclaw config patch --file`: agent `family` in the family group. Only at the @Family_fff_bot handover (see openclaw/README.md) |
| `save-bot-token` | `/usr/local/sbin/save-bot-token`: `ssh -t root@<server> save-bot-token <name>` saves a Telegram bot token from a hidden prompt |
| `check.sh` | Root helper: `bash check.sh status\|logs\|doctor\|audit\|test\|mem` (redacts secrets) |
| `laptop/` | Not for the server: Claude Code permissions for server work from the laptop (Machina). `powershell -ExecutionPolicy Bypass -File server\laptop\install.ps1` writes `.claude\settings.local.json` and merges the `autoMode` block into `~\.claude\settings.json` (backup first, JSON validated) |

## Changing config later

Once the gateway runs, change settings with `openclaw config set ...` or
`openclaw models ...` as the openclaw user. The gateway treats outside edits to
`openclaw.json` as untrusted and may restore its last good copy, so copying the
template over a live config does not stick. Keep `openclaw.json5` here in step
with what you set.

## Family agent jobs

Since the cutover (2026-10-23) the server runs the jobs; GitHub's "Family agent"
workflow (tick.yml) is disabled. The server's `~/family-agent/state/state.json`
is now the live state; the `state` branch on GitHub is frozen at the cutover.
To move back to GitHub: stop the timer, push the server's state.json to the
`state` branch, then `gh workflow enable tick.yml`. Never run both at once:
they share one Telegram bot and one state.

## Family dashboard (pinned picture)

`src/dashboard` draws the family dashboard (Kunto design) as a PNG and keeps it
pinned in the family group: the 15-minute tick re-renders it only when the
content changed and edits the pinned message in place (no notification). It
needs headless Chromium on the server. To switch it on (server thread):

1. As user openclaw: `cd ~/family-agent && npx -y playwright@1.63.0 install chromium`
   (root once for the system libraries: `npx -y playwright@1.63.0 install-deps chromium`).
   The renderer finds Playwright's Chromium in `~/.cache/ms-playwright`, or use `CHROME_BIN`
2. Check: `~/family-agent-run.sh dashboard --png /tmp/dash.png` and look at the picture
3. @Family_fff_bot must be a group admin with "Pin messages"
4. `~/family-agent-run.sh dashboard --send` posts and pins the first one (the group sees
   one "pinned a photo" line), then set `dashboard.enabled: true` in config.yaml
5. Memory: Chromium runs about 1–2 s per changed picture, a few times a day

## Backups

Every night at 02:30 the server packs the OpenClaw backup (`openclaw backup
create --verify`), `~/.secrets` (family-agent secrets, API key, gateway token)
and `~/family-agent/state`, encrypts it with age to the laptop's public key, and
force-pushes it to the private repo `henrijantti/family-agent-backup` (newest
14 kept, one commit). The server cannot decrypt its own backups.

Keys:
- Private key: laptop, `%USERPROFILE%\.secrets\family-agent-backup.agekey`.
  Keep a copy in the password manager; without it the backups are unreadable.
- Public key: server, `~/.backup/recipient.txt`.
- Push access: server, `~/.backup/deploy_key` (deploy key with write access to
  the backup repo only).

Restore (on the laptop, PowerShell):

```
gh repo clone henrijantti/family-agent-backup $env:TEMP\fab
$f = Get-ChildItem $env:TEMP\fab\backup-*.age | Sort-Object Name | Select-Object -Last 1
age -d -i $HOME\.secrets\family-agent-backup.agekey -o $env:TEMP\fab\restore.tar.gz $f.FullName
tar -tzf $env:TEMP\fab\restore.tar.gz     # list contents
```

On a rebuilt server, copy `restore.tar.gz` over Tailscale SSH and, as openclaw:
put `secrets/*` back in `~/.secrets/` (700/600), `family-agent-state/` back as
`~/family-agent/state/`, and restore OpenClaw with
`openclaw backup restore openclaw-backup.tar.gz --target ~/.openclaw` (gateway
stopped). Delete the decrypted files afterwards.

## Day to day

- Control UI: `https://<server>.<tailnet>.ts.net/` from a tailnet device; log in
  with the token from `gateway.env`.
- Service status, as root:
  `runuser -u openclaw -- env XDG_RUNTIME_DIR=/run/user/$(id -u openclaw) systemctl --user status openclaw-gateway`
  (logs: same prefix with `journalctl --user -u openclaw-gateway`).
- Rootless Docker relies on Ubuntu's own `/etc/apparmor.d/rootlesskit` profile.
  Don't add a second profile for `/usr/bin/rootlesskit`; two profiles on one path break it.
- Emergency access if Tailscale breaks: UpCloud web console.
