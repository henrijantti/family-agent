# OpenClaw agent: Henri's assistant

One OpenClaw agent in a private Telegram chat with Henri. It answers about the
family calendars and bills, adds events (also from photos of notices), and runs
Henri's Brain vault: capture to inbox, queries, supervised ingest, lint.

It acts only through two tool servers in this repo, started on the host by the
gateway. The agent's sandbox stays as it is (no network, no secrets, no shell).

| Server | Command | Tools |
| --- | --- | --- |
| family | `family-agent-run.sh mcp family` | `calendar_list`, `calendar_add`, `calendar_update`, `calendar_delete`, `week_overview`, `digest_data`, `bills_list`, `week_plan` (not in the `--group` copy) |
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
| Sun 19:10 | `Week plan. Call week_plan and post its text exactly as returned: no additions, no rewording, no reformatting.` |

8. **Smoke test** in the DM: "mitä viikonloppuna?", "lisää Oskarille hammaslääkäri ti 15:00
   kouluun" then "poista se", send a photo of any notice, "brain: test capture", "ingest"

Memory: one more agent and two small Node processes; check `free -m` after start
(about 1.1 GB was free before).

## Email agent (second agent, own bot)

A separate agent `email` for Henri's Outlook: sort, label, draft replies, flag
bills, and send a reply only after Henri taps Allow. Instructions:
`openclaw/workspace-email/AGENTS.md`. It never shares tools, bot or memory with
`henri`, so email text can't steer the agent that has the calendar and Brain. The
only link is the mail desk (below), which carries ids, categories and numbers, no text.

| Server | Command | Tools |
| --- | --- | --- |
| mail | `family-agent-run.sh mcp mail` | `mail_inbox`, `mail_read`, `mail_folders`, `mail_create_folder`, `mail_move`, `mail_label`, `mail_draft_reply`, `mail_bill_pdf`, `mail_send` (only with `outlook.email_agent.send: true`) |

Guarantees in code (src/agent/mail-tools.ts, src/sources/outlook.ts):

- No forward, delete or inbox-rule tools. Moves to Deleted Items, Junk, Sent, Drafts
  or Outbox are refused
- `mail_send` sends only a draft `mail_draft_reply` recorded, once, addressed to
  exactly the original sender with no Cc/Bcc, and only with a fresh (15 min)
  Allow in `mail-approvals.jsonl`. That file is written only by the
  `mail-approval` plugin when Henri answers the card, so without the plugin
  nothing sends (fails closed). Every other Graph send path stays blocked
- Email content is returned marked untrusted
- `mail_bill_pdf` (src/sources/bill-pdf.ts) reads PDF attachments read-only with
  pdf.js (no eval, no fonts, 5 MB, 4 pages, 20 s cap) and returns only amount,
  currency, due date, IBAN and reference, each format-checked and IBAN/reference
  check-digit-checked. The PDF's text never leaves the tool. Reads are recorded
  in `state/mail-bill-pdf.jsonl`

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
| Daily 07:30 | `Morning sort. Call mail_rules, then mail_inbox for the last day. Follow the rules, label bills Lasku and flag them, and move clear newsletters, notifications and receipts as AGENTS.md says. Send Henri at most 8 lines: what you moved (by folder, with counts), bills with due dates, suspected phishing, and emails that need Henri's answer, each with a one-line suggested reply to approve.` |
| Sun 18:00 | `Weekly newsletter review. Call mail_inbox for 7 days for the Inbox, Archive and each folder where newsletters go (Uutiskirjeet and any folder rule). List the senders of newsletters and marketing mail with how many each sent, and ask Henri which to unsubscribe from (Henri unsubscribes; you never open their links). Label those emails "Peru tilaus?".` |

7. **Learned rules**: no setup. The agent sorts clear newsletters, notifications and
   receipts, and saves Henri's corrections with `mail_rule` to `state/mail-rules.jsonl`
   (server only). **USER.md** in the `email` workspace (optional, not in git): recurring
   bills and 3-5 sample replies

Known gap: the mail server reads state but doesn't save rotated refresh tokens.
Microsoft keeps old ones valid, and the 15-minute tick saves its own.

## Chief of staff and the mail desk (2026-10-24)

Henri's design: three bots. The Chief of staff (agent `henri`, @helperwnkdbot,
Henri only) runs his personal automation; the Family bot (agent `family`) lives in
the family group; the Email agent keeps its own bot. Calendar and Brain are tools
of the Chief of staff, not bots. Family finance comes later as one more agent
under the Chief of staff, Henri only, without payment tools.

The Chief of staff coordinates email without reading it (Henri chose this on
2026-10-24): it gives the Email agent tasks and gets back structured results.

| Server | Command | Tools | Agent |
| --- | --- | --- | --- |
| desk | `family-agent-run.sh mcp desk` | `desk_task_create`, `desk_results` | `henri` only |
| mail | `family-agent-run.sh mcp mail` | (mail tools) + `desk_tasks`, `desk_report` | `email` only |

Guarantees in code (src/agent/desk.ts):

- The `desk` server has no Outlook access and no mail secrets; it reads and writes
  `state/mail-desk.jsonl` only
- A report is schema-checked: message ids, a category from a fixed list, ISO due
  date, numeric amount, currency, IBAN and reference (both must pass their check
  digits), draft id, counts. Anything else is refused
- Code marks a bill `fromPdf` when its IBAN/reference match what `mail_bill_pdf`
  read, and `ibanChanged` when the same sender domain reported another IBAN before
  (Henri's week plan shows a warning)
- Sender address and received time are filled in by code from Outlook, never by
  the agent. Subjects, bodies and sender names are never stored
- Agent-to-agent messaging stays off; the desk file is the only link

Deploy (server thread):

1. `git pull`, then `openclaw config patch --file server/cos-desk.patch.json5`
   (renames `henri` to "Chief of staff", adds the `desk` server and tool policy)
2. Copy `openclaw/workspace/AGENTS.md` and `openclaw/workspace-email/AGENTS.md` into
   the two workspaces again
3. Cron job on agent `email`, name `mail-desk`, every 2 hours 07:00-21:00 Helsinki,
   no delivery unless it has something: `Mail desk. Call desk_tasks. If there are none, stop without a message. Otherwise do each task and answer it with desk_report, then tell Henri in one line what the Chief of staff asked and that it is done.`
4. Optional instant pickup: set `MAIL_DESK_WAKE='["openclaw","cron","run","mail-desk"]'`
   (or the 2026.10.6 equivalent) in the env `family-agent-run.sh` loads, so a new
   task starts the cron job at once
5. Probe: `openclaw mcp doctor desk --probe`; in the Chief of staff chat ask
   "montako sähköpostia odottaa vastaustani?", then check the mail bot answered the task

## Family agent (at the @Family_fff_bot handover)

Agent `family`, instructions `openclaw/workspace-family/AGENTS.md`, config
`server/family-agent.patch.json5`. Tools: the group copies of the family and jobs
servers (`mcp family --group`, `mcp jobs --group`), which leave out Henri's bills in
code: no `bills_list`, no `scan_bills`, `digest_data` without `billsToday`, and its
`digest_mark_sent` doesn't use up bill reminders. No Brain, mail or desk, so nothing
private reaches the group. Bill reminders go to Henri through the Chief of staff
instead (step 4 cron). In the group only allowlisted senders can trigger it (Henri; his spouse
once Henri gives the id) and only by @-mention or reply; bot privacy mode stays on.
Deploy it at step 3 below, not before: until then the scripts read
@Family_fff_bot with getUpdates. At that point the shadow and cutover digest crons
move from agent `henri` to agent `family` (step 4).

## Moving the jobs to OpenClaw (plan)

Henri chose to have the AI run the jobs. The order keeps the family group from getting
anything twice and keeps a working fallback at each step:

1. **Now: shadow.** The Chief of staff (`henri`) writes the digest and the week summary
   to Henri's DM from `digest_data`; the scripts still post to the family group. Henri
   compares a few days
2. **Sync and bills.** Add `myclub` and `outlook` to `agent_jobs` and create the sync
   crons below (agent `henri`, Henri's DM) in the same step. They replace the tick's
   runs, never alongside. Built. Needs the `jobs` server on `henri` too
3. **Handover + attendance, one deploy.** The family group gets one bot, @Family_fff_bot,
   run by agent `family` (design of 2026-10-24: no second bot in the group). Only the
   attendance poll reads that bot with getUpdates, so both move together, on a Monday
   after the 06:15 apply: stop the timer, add `attendance-poll` and `attendance-apply`
   to `agent_jobs`, deploy `server/family-agent.patch.json5` with @Family_fff_bot's
   token, create the two step-3 crons on agent `family`, start the timer. The agent
   posts one message per child with a button per event (`att|<child>|<eventId>|1`
   going, `|0` not going), presses come back as `callback_data` and go to
   `attendance_record`, Monday's `attendance_apply` runs the existing MyClub sign-up
   code. Unlike the Telegram poll, events nobody pressed are left alone. Built. The
   scripted digest keeps sending with the same token (sending doesn't clash with polling)
4. **Digest cutover.** Point the two digest crons at agent `family` in the group,
   then add `digest` and `week-ahead` to `agent_jobs` so the script stops. The prompt
   ends with `digest_mark_sent`, so bills and Wilma items aren't repeated. Built

Each step: change config.yaml in the repo (GitHub is master), deploy, then create the
crons. To go back, remove the jobs from `agent_jobs` and pause the crons.

| Step | When (Helsinki) | Delivered to | Prompt |
| --- | --- | --- | --- |
| 4 | Daily 06:45 | family group (`family`) | `Morning digest. Call digest_data with kind daily and write today's digest following the digest rules in AGENTS.md. Post it, then call digest_mark_sent with kind daily.` |
| 4 | Sun 19:00 | family group (`family`) | `Week summary. Call digest_data with kind week and write next week's summary following the digest rules in AGENTS.md. Post it, then call digest_mark_sent with kind week.` |
| 4 | Daily 06:50 | Henri's DM (`henri`) | `Bill reminders. Call digest_data with kind daily. If billsToday is not empty, list each bill in one line (biller, amount, due date, reference). Otherwise reply only NO_REPLY.` |
| 2 | Daily 06:15 | Henri's DM (`henri`) | `MyClub sync. Call sync_myclub. If alerts is not empty, post each alert. If health is not ok, say so in one line. Otherwise reply only NO_REPLY.` |
| 2 | Daily 06:20 | Henri's DM (`henri`) | `Bill scan. Call scan_bills. List each new bill in one line (biller, amount, due date, mark new billers). If none, reply only NO_REPLY.` |
| 3 | Sun 19:00 | family group (`family`) | `Practice question. Call attendance_week. For each child with events, send one message to this group with the message tool: text "<child>: ensi viikon treenit", and a presentation with one buttons block holding two buttons per event. Each button has ONLY "label" and "value", never an "action" field: {"label": "✅ <label>", "value": "att|<child>|<eventId>|1"} and {"label": "➖ <label>", "value": "att|<child>|<eventId>|0"}. After sending, reply with one short line: which children got a question.` (delivery none: the agent posts itself) |
| 3 | Mon 06:15 | family group (`family`) | `Apply practice answers. Call attendance_apply and post the results per child in Finnish. Name children nobody answered for.` |

The step 2 times follow config.yaml's MyClub and Outlook `runs`. Check that OpenClaw
2026.10.6 drops a `NO_REPLY` cron answer (or adjust the wording).

Found live at the step 3 handover (2026-10-25):
- A button with an `action` field gets an opaque `tgcb1:` value that only a plugin can
  claim, so the press ends in "This action is no longer available". Plain `label` +
  `value` buttons reach the agent as `callback_data: <value>`
- The bot in privacy mode gets button presses and replies to its own messages, but not
  plain @-mentions. It is a group admin (no rights) so mentions arrive; `requireMention`
  keeps it quiet otherwise
- Making it admin turned the group into a supergroup with a new chat id. OpenClaw moved
  its `groups` entry itself; `TELEGRAM_FAMILY_CHAT_ID` and the two step 3 crons were
  changed by hand

ChatGPT Plus usage: two short AI runs a day for the digest, more for polls. The scripts
used none. If the 5-hour or weekly limit is hit, OpenClaw falls back to Claude Sonnet
(pay per use); that fallback is untested.

## Not built yet

- **Paperwork filing** beyond the bill list: filing letters and PDFs needs a place to
  file them (Google Drive) and access to it, which the server doesn't have
- **Builder loop** (Telegram request to a family-agent PR): needs a coding sandbox with
  network and a GitHub credential limited to branches. Left out on purpose for now
