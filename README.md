# Family agent

One codebase, one daily Telegram message for the family:

- **Calendar hub**: the family Google calendar. The agent writes only its own two calendars, *Family: School (Wilma)* and *Family: Hobbies (MyClub)*, and only reads the main family calendar.
- **Wilma** (school), via [`@wilm-ai/wilma-client`](https://www.npmjs.com/package/@wilm-ai/wilma-client): exams and dated bulletin items into the School calendar; homework, lessons, new messages and notes into the digest; urgent items as alerts at 12:00 and 16:00.
- **MyClub** (hobbies): trainings and games into the Hobbies calendar; sign-ups closing and fees due into the digest. **Unverified**: the reader has not been run against the real myclub.fi yet.
- **Outlook** (Henri's private mail), via Microsoft Graph: daily bill scan, reminders 3 days before and on the due date, reply drafts on request. It cannot send mail: no `Mail.Send` permission, and the client refuses send endpoints.
- **Digest** at 06:45 Helsinki every day, week-ahead on Sunday 19:00, to a Telegram family group. The bot only sends.

Setup steps for Henri: [docs/SETUP.md](docs/SETUP.md).

## How it runs

GitHub Actions (`.github/workflows/tick.yml`) ticks at fixed UTC times that cover both summer and winter time. Each tick works out in Helsinki time which jobs are due (see `config.yaml`) and runs them in order: MyClub, Outlook, Wilma, then the digest. State (ids already seen, the Wilma session, the rotated Outlook token, bills) is one AES-encrypted file on the `state` branch, keyed by the `STATE_KEY` secret.

Wilma is the exception: its Cloudflare protection refuses GitHub's servers, so `.github/workflows/wilma.yml` runs `wilma-fetch` on a self-hosted runner on Henri's laptop (label `wilma`) about 20 minutes before each Wilma slot. It writes an encrypted snapshot to the `state-wilma` branch, and the GitHub tick reads it (`WILMA_MODE=snapshot`). A snapshot older than 3 hours counts as Wilma unavailable.

Calendar safety (from the hub plan): deterministic event ids from source + source id, a fingerprint in private extended properties, update only on change, delete only after an item is missing on 2 runs, and a run that wants to delete more than 5 events stops and alerts instead. Events without the agent's fingerprint are never touched.

## Commands

```bash
npm ci
npm test               # 25 tests on fixtures, no logins needed
npm run demo           # full run on fixtures; prints the digest it would send
npm run agent -- check # which secrets are set; does the cron cover config.yaml
npm run agent          # all commands
```

The **Setup helpers** workflow runs the same commands in GitHub with the repository secrets (Actions tab > Setup helpers > Run workflow).

## Settings and open decisions

All in `config.yaml`: digest times (weekend time is open, default 06:45), language (en/fi), Wilma run times, grades (default off, never sent to Telegram), MyClub mode and horizon, bill reminder timing and whether bills go to the family group or Henri's private chat.

## Layout

```
src/cli.ts              commands
src/jobs.ts             scheduler and the per-source jobs
src/calendar/           Google client (service account), sync/dedup, in-memory fake
src/sources/wilma.ts    Wilma reader + exam/bulletin events + new-item diff
src/sources/myclub.ts   MyClub feed + member-page reader (unverified)
src/sources/outlook.ts  Graph client (no send), device sign-in, bill detection
src/digest/build.ts     the combined digest
src/notify/telegram.ts  send-only bot
test/                   fixtures and tests
```

## OpenClaw assistant

`openclaw/` holds the private Telegram assistant: two tool servers (`npm run agent -- mcp family|brain`),
its instructions and the deploy steps. See [openclaw/README.md](openclaw/README.md).
