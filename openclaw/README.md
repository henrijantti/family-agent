# OpenClaw agent: Henri's assistant

One OpenClaw agent in a private Telegram chat with Henri. It answers about the
family calendars and bills, adds events (also from photos of notices), and runs
Henri's Brain vault: capture to inbox, queries, supervised ingest, lint.

It acts only through two tool servers in this repo, started on the host by the
gateway. The agent's sandbox stays as it is (no network, no secrets, no shell).

| Server | Command | Tools |
| --- | --- | --- |
| family | `family-agent-run.sh mcp family` | `calendar_list`, `calendar_add`, `calendar_update`, `calendar_delete`, `week_overview`, `digest_data`, `bills_list` |
| brain | `family-agent-run.sh mcp brain` | `brain_capture`, `brain_index`, `brain_read`, `brain_search`, `brain_inbox`, `brain_lint`, `brain_propose` |
| jobs | `family-agent-run.sh mcp jobs` | `sync_myclub`, `scan_bills`, `digest_mark_sent`, `attendance_week`, `attendance_record`, `attendance_apply` (each refuses until its job is in `agent_jobs`, see below) |

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
- The jobs server writes state, so it and the 15-minute tick take a lock on the state
  file (`state.json.lock`, one writer at a time). A job runs in one place only: the
  tick skips every job listed in config `agent_jobs`, and the job tools refuse any job
  not listed. `attendance_apply` acts only on events Henri answered with a button
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

7. **AI-written digest, shadow mode** (Henri chose "fully native, AI does the jobs",
   2026-10-23). Two more cron jobs on agent `henri`, delivered to Henri's DM only, while
   the scripted digest keeps posting to the family group:

| When | Prompt |
| --- | --- |
| Daily 06:50 | `Morning digest, shadow run. Call digest_data with kind daily and write today's digest following the digest rules in AGENTS.md. Start with "Varjoajo:" so Henri knows it's the test version.` |
| Sun 19:05 | `Week summary, shadow run. Call digest_data with kind week and write next week's summary following the digest rules in AGENTS.md. Start with "Varjoajo:".` |

8. **Smoke test** in the DM: "mitä viikonloppuna?", "lisää Oskarille hammaslääkäri ti 15:00
   kouluun" then "poista se", send a photo of any notice, "brain: test capture", "ingest"

Memory: one more agent and two small Node processes; check `free -m` after start
(about 1.1 GB was free before).

## Email agent (second agent, own bot)

A separate agent `email` for Henri's Outlook: sort, label, draft replies, flag
bills, and send a reply only after Henri taps Allow. Instructions:
`openclaw/workspace-email/AGENTS.md`. It never shares tools, bot or memory with
`henri`, so email text can't steer the agent that has the calendar and Brain.

| Server | Command | Tools |
| --- | --- | --- |
| mail | `family-agent-run.sh mcp mail` | `mail_inbox`, `mail_read`, `mail_folders`, `mail_create_folder`, `mail_move`, `mail_label`, `mail_draft_reply`, `mail_send` (only with `outlook.email_agent.send: true`) |

Guarantees in code (src/agent/mail-tools.ts, src/sources/outlook.ts):

- No forward, delete or inbox-rule tools. Moves to Deleted Items, Junk, Sent, Drafts
  or Outbox are refused
- `mail_send` sends only a draft `mail_draft_reply` recorded, once, addressed to
  exactly the original sender with no Cc/Bcc, and only with a fresh (15 min)
  Allow in `mail-approvals.jsonl`. That file is written only by the
  `mail-approval` plugin when Henri answers the card, so without the plugin
  nothing sends (fails closed). Every other Graph send path stays blocked
- Email content is returned marked untrusted

Deploy (server thread, after Henri's OK):

1. **Bot:** Henri makes one more BotFather bot (e.g. "Henri Mail"). Add it as a
   second OpenClaw Telegram account, DMs allowlisted to Henri's user id, no groups,
   and bind it only to agent `email`
2. **Agent:** add agent `email` with its own workspace, copy
   `openclaw/workspace-email/AGENTS.md` into it, model `anthropic/claude-sonnet-5-5`
   (plugin approvals don't work under the codex runtime yet, openclaw#173073), sandbox mode all
3. **Tool server:** register `mail` under `mcp.servers` (command
   `/home/openclaw/family-agent-run.sh`, args `["mcp","mail"]`), probe it. Tool policy
   for `email`: only the `mail` MCP tools plus messaging; no exec, file, browser or
   image tools. `henri` and every other agent get no `mail` tools
4. **Approval plugin:** install from the local path
   `/home/openclaw/family-agent/openclaw/plugins/mail-approval` (local install, not
   ClawHub; allow it in the install policy for this path only), config
   `stateDir=/home/openclaw/family-agent/state`. Check the manifest and
   `before_tool_call` / `requireApproval` against 2026.10.6 first, then test one
   send to Henri's own Gmail
5. **Sending on:** Henri adds the delegated Graph permission `Mail.Send` to the Entra
   app. Then set `outlook.email_agent.send: true` and run `family-agent-run.sh
   outlook-login` once on the server (device code, asks for Mail.Send). Until then
   the agent drafts only
6. **Schedules** (OpenClaw cron, agent `email`, to Henri's mail DM), times Helsinki:

| When | Prompt |
| --- | --- |
| Daily 07:30 | `Morning sort. Read USER.md, then call mail_inbox for the last day. Label bills Lasku and flag them, apply Henri's sender rules and folder plan, and send Henri at most 8 lines: what you moved, bills with due dates, suspected phishing, and emails that need Henri's answer, each with a one-line suggested reply to approve.` |
| Sun 18:00 | `Weekly newsletter review. Call mail_inbox for 7 days for the Inbox, Archive and each folder in USER.md where newsletters go. List the senders of newsletters and marketing mail with how many each sent, and ask Henri which to unsubscribe from (Henri unsubscribes; you never open their links). Label those emails "Peru tilaus?".` |

7. **USER.md** in the `email` workspace (server only, not in git): Henri's folder plan,
   always-important senders, auto-archive senders, recurring bills, 3-5 sample replies

Known gap: the mail server reads state but doesn't save rotated refresh tokens.
Microsoft keeps old ones valid, and the 15-minute tick saves its own.

## Moving the jobs to OpenClaw (plan)

Henri chose to have the AI run the jobs. The order keeps the family group from getting
anything twice and keeps a working fallback at each step:

1. **Now: shadow.** The AI writes the digest and the week summary to Henri's DM from
   `digest_data`; the scripts still post to the family group. Henri compares a few days
2. **Digest cutover.** Add the new bot to the family group, point the two digest cron
   jobs at the group (prompts below), then add `digest` and `week-ahead` to `agent_jobs`
   in config.yaml so the script stops. The prompt ends with `digest_mark_sent`, so bills
   and Wilma items aren't repeated. Built
3. **Sync and bills.** Add `myclub` and `outlook` to `agent_jobs` and create the sync
   crons below in the same step. They replace the tick's runs, never alongside. Built
4. **Attendance.** Add `attendance-poll` and `attendance-apply` to `agent_jobs` with the
   two crons below. The agent posts one message per child with a button per event
   (`att|<child>|<eventId>|1` going, `|0` not going), presses come back to the agent as
   `callback_data` and go to `attendance_record`, Monday's `attendance_apply` runs the
   existing MyClub sign-up code. Unlike the Telegram poll, events nobody pressed are
   left alone (the poll declined unticked ones). Last step, since it signs the boys up
   and out in MyClub. Built

Each step: change config.yaml in the repo (GitHub is master), deploy, then create the
crons. To go back, remove the jobs from `agent_jobs` and pause the crons.

| Step | When (Helsinki) | Delivered to | Prompt |
| --- | --- | --- | --- |
| 2 | Daily 06:45 | family group | `Morning digest. Call digest_data with kind daily and write today's digest following the digest rules in AGENTS.md. Post it, then call digest_mark_sent with kind daily.` |
| 2 | Sun 19:00 | family group | `Week summary. Call digest_data with kind week and write next week's summary following the digest rules in AGENTS.md. Post it, then call digest_mark_sent with kind week.` |
| 3 | Daily 06:15 | Henri's DM | `MyClub sync. Call sync_myclub. If alerts is not empty, post each alert. If health is not ok, say so in one line. Otherwise reply only NO_REPLY.` |
| 3 | Daily 06:20 | Henri's DM | `Bill scan. Call scan_bills. List each new bill in one line (biller, amount, due date, mark new billers). If none, reply only NO_REPLY.` |
| 4 | Sun 19:00 | family group | `Practice question. Call attendance_week. For each child with events, post one message "<child>: ensi viikon treenit" with two buttons per event, "✅ <label>" (att|<child>|<eventId>|1) and "➖ <label>" (att|<child>|<eventId>|0).` |
| 4 | Mon 06:15 | family group | `Apply practice answers. Call attendance_apply and post the results per child in Finnish. Name children nobody answered for.` |

The step 3 times follow config.yaml's MyClub and Outlook `runs`. Check that OpenClaw
2026.10.6 drops a `NO_REPLY` cron answer (or adjust the wording), and that inline
buttons work in groups for the bot.

5. **Bot handover.** When nothing in family-agent reads getUpdates (polls moved; the email
   agent has its own bot and uses OpenClaw approvals), `@Family_fff_bot`'s token can move to
   OpenClaw and the extra bot goes away

ChatGPT Plus usage: two short AI runs a day for the digest, more for polls. The scripts
used none. If the 5-hour or weekly limit is hit, OpenClaw falls back to Claude Sonnet
(pay per use); that fallback is untested.

## Not built yet

- **Writes to the main Perhe calendar.** Henri's rule so far: the agent only reads it.
  Personal appointments (dentist) go to School or Hobbies until he decides
- **Paperwork filing** beyond the bill list: filing letters and PDFs needs a place to
  file them (Google Drive) and access to it, which the server doesn't have
- **Builder loop** (Telegram request to a family-agent PR): needs a coding sandbox with
  network and a GitHub credential limited to branches. Left out on purpose for now
