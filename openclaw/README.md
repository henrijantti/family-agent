# OpenClaw agent: Henri's assistant

One OpenClaw agent in a private Telegram chat with Henri. It answers about the
family calendars and bills, adds events (also from photos of notices), and runs
Henri's Brain vault: capture to inbox, queries, supervised ingest, lint.

It acts only through two tool servers in this repo, started on the host by the
gateway. The agent's sandbox stays as it is (no network, no secrets, no shell).

| Server | Command | Tools |
| --- | --- | --- |
| family | `family-agent-run.sh mcp family` | `calendar_list`, `calendar_add`, `calendar_update`, `calendar_delete`, `week_overview`, `bills_list` |
| brain | `family-agent-run.sh mcp brain` | `brain_capture`, `brain_index`, `brain_read`, `brain_search`, `brain_inbox`, `brain_lint`, `brain_propose` |

Try any tool once from a shell: `npm run agent -- tool family calendar_list '{"from":"2026-10-26"}'`.

## Guarantees enforced in code (not in the prompt)

- Calendar writes reach only the School and Hobbies calendars, and change or remove
  only events tagged `family-agent-chat` (made by this chat). Synced Wilma/MyClub
  events and the human Perhe calendar can't be touched. The sync ignores chat events,
  so it never deletes them. Removing is Google's cancel, not a permanent delete
- The family server reads the job state fresh per call and never saves it, so it
  can't race the 15-minute tick. Nothing here sends Telegram messages or email
- Brain capture writes only new files in `inbox/` (never overwrites) and pushes to main
- Brain ingest goes to an `ingest/*` branch; Henri merges it on GitHub. The agent
  can't write vault pages on main, can't change `raw/` files, `AGENTS.md`,
  `CLAUDE.md` or `templates/`, and can't read or write excluded folders
  (`health/` by default, `BRAIN_EXCLUDE`)
- Every tool argument is checked against its schema; unknown arguments are refused
- git runs with fixed arguments through execFile, no shell

## Deploy (server thread)

Not yet run. The OpenClaw config keys below follow docs.openclaw.ai as read on
2026-10-23 and need checking against 2026.10.6 (`openclaw config set` only, the
gateway rewrites hand edits).

1. **Telegram:** Henri makes a NEW bot in BotFather (never `@Family_fff_bot`: the
   jobs read its updates with getUpdates and a second reader would steal the poll
   answers). Connect it as an OpenClaw Telegram channel with DMs allowlisted to
   Henri's Telegram user id only, no groups
2. **Brain clone:** Henri adds a deploy key with write access on henrijantti/Brain
   (GitHub > repo > Settings > Deploy keys). Generate it on the server as user
   openclaw (`ssh-keygen -t ed25519 -f ~/.ssh/brain_deploy -N ""`), clone with
   `GIT_SSH_COMMAND='ssh -i ~/.ssh/brain_deploy' git clone git@github.com:henrijantti/Brain.git ~/brain`
   and set `git -C ~/brain config core.sshCommand 'ssh -i ~/.ssh/brain_deploy -o IdentitiesOnly=yes'`
3. **Environment for the wrapper:** `BRAIN_DIR=/home/openclaw/brain`,
   `BRAIN_EXCLUDE=health` (until Henri decides otherwise). Optional:
   `BRAIN_GIT_NAME`, `BRAIN_GIT_EMAIL`
4. **Agent:** add agent `henri` with its own workspace, copy `openclaw/workspace/AGENTS.md`
   into it, bind it to the new bot's DM with Henri. Sandbox as the default (mode all)
5. **Tool servers:** register both stdio servers under `mcp.servers` (command
   `/home/openclaw/family-agent-run.sh`, args `["mcp","family"]` and `["mcp","brain"]`),
   then `openclaw mcp doctor <name> --probe`. Restrict the `henri` agent's tool policy
   to these MCP tools plus messaging and image reading; no exec, file or browser tools.
   Other agents get neither server
6. **Schedules** (OpenClaw cron, agent `henri`, delivered to Henri's DM), times Helsinki:

| When | Prompt |
| --- | --- |
| Thu 20:30 | `Weekly evidence question. Call brain_lint, pick ONE principle from principlesWithoutEvidence (rotate, not the same as last week), read it, and ask Henri one short question about a real moment this week that showed it or went against it. If he answers, capture his answer verbatim to the inbox titled "evidence: <principle>".` |
| Sat 10:00 | `Inbox nudge. Call brain_inbox. If it has items, tell Henri how many and the three oldest titles, and offer to ingest one now. If empty, say so in one line.` |
| 1st of month 09:00 | `Monthly lint. Call brain_lint and report in at most 8 lines: inbox backlog, index drift, orphans, overdue reviews, principles still without evidence. Then ask the nextQuizQuestion as a quiz.` |

7. **Smoke test** in the DM: "mitä viikonloppuna?", "lisää Oskarille hammaslääkäri ti 15:00
   kouluun" then "poista se", send a photo of any notice, "brain: test capture", "ingest"

Memory: one more agent and two small Node processes; check `free -m` after start
(about 1.1 GB was free before).

## Not built yet

- **Writes to the main Perhe calendar.** Henri's rule so far: the agent only reads it.
  Personal appointments (dentist) go to School or Hobbies until he decides
- **Paperwork filing** beyond the bill list: filing letters and PDFs needs a place to
  file them (Google Drive) and access to it, which the server doesn't have
- **Builder loop** (Telegram request to a family-agent PR): needs a coding sandbox with
  network and a GitHub credential limited to branches. Left out on purpose for now
