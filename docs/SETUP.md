# Setup: what Henri does (one session, about 90 minutes)

Do the steps in order. Every password, token and key goes into **GitHub repository secrets** (Settings > Secrets and variables > Actions > New repository secret), never into chat. Ids that are not secret (calendar ids, chat ids) also go there, to keep everything in one place.

Secrets page once the repo exists: https://github.com/henrijantti/family-agent/settings/secrets/actions
Helpers: https://github.com/henrijantti/family-agent/actions/workflows/setup.yml (Run workflow > pick a command)

## 1. Repository (2 min)
1. Create an empty **private** repo named `family-agent` at https://github.com/new (no README, no licence).
2. Tell Claude in the thread; Claude pushes the code.
3. Add secret `STATE_KEY`: a long random passphrase from your password manager (40+ characters). Keep a copy in the password manager; without it the saved state can't be read.

## 2. Telegram (10 min)
1. In Telegram, open https://t.me/BotFather, send `/newbot`, name it (e.g. "Family agent"). Add the token as secret `TELEGRAM_BOT_TOKEN`.
2. Create a group (e.g. "Perhe"), add the bot, and send `/start@<botname>` in the group.
3. Optional, for bills: open a private chat with the bot and send `/start`.
4. Run helper **telegram-chats**. Add the group's id (negative number) as `TELEGRAM_FAMILY_CHAT_ID`; optionally your private chat id as `TELEGRAM_PRIVATE_CHAT_ID`.
5. Run helper **telegram-test**: a hello appears in the group.

## 3. Google calendar hub (20 min, signed in as the FAMILY Gmail account)
1. Create a project: https://console.cloud.google.com/projectcreate (name `family-agent`).
2. Enable the Calendar API: https://console.cloud.google.com/apis/library/calendar-json.googleapis.com
3. Create a service account: https://console.cloud.google.com/iam-admin/serviceaccounts > Create, name `family-agent`, no roles. Open it > Keys > Add key > JSON. Paste the whole file's contents as secret `GOOGLE_SA_KEY`, then delete the downloaded file. Note its email (`family-agent@….iam.gserviceaccount.com`).
4. In https://calendar.google.com > Settings > Add calendar > Create new calendar: create **Family: School (Wilma)** and **Family: Hobbies (MyClub)**.
5. Share each of the two new calendars with the service account email: *Make changes to events*. Share the main family calendar with it: *See all event details*.
6. For each calendar, Settings > Integrate calendar > Calendar ID. Add as `GOOGLE_SCHOOL_CALENDAR_ID`, `GOOGLE_HOBBIES_CALENDAR_ID` and `GOOGLE_FAMILY_CALENDAR_ID` (the main calendar's id is usually the Gmail address).
7. Run helper **calendar-smoke**: it reads all three and writes + removes a test event.

## 4. Wilma (20 min, runs from your laptop)
Wilma's Cloudflare protection refuses GitHub's servers, so a small GitHub runner on your Windows laptop does only the Wilma fetch (06:10, 11:40, 15:40 weekdays, 18:25 Sunday). It saves an encrypted snapshot; everything else still runs in GitHub. If the laptop is off, the digest says Wilma is unavailable that day.
1. Secrets: `WILMA_TENANT` (e.g. `https://<city>.inschool.fi`), `WILMA_USERNAME`, `WILMA_PASSWORD`, and `WILMA_TOTP_SECRET` if Wilma asks for an authenticator code.
2. Install Git for Windows if you don't have it: https://git-scm.com/download/win (defaults are fine; it provides the `bash` the runner uses).
3. https://github.com/henrijantti/family-agent/settings/actions/runners/new > **Windows**, x64. In PowerShell, run the commands shown under *Download* and *Configure*. When `config.cmd` asks: runner group Enter, name Enter, **labels: `wilma`**, work folder Enter, **run as service: Y** (account: Enter for the default).
4. The runner shows as *Idle* on https://github.com/henrijantti/family-agent/settings/actions/runners.
5. Actions > **Wilma fetch (laptop)** > Run workflow. Then Setup helpers > **wilma-students** and tell Claude the children's names as you want them shown.

## 5. MyClub (5 min)
1. In MyClub > Kalenteritilaukset, click **Kopioi linkki** on each subscription.
2. Per child, two subscriptions: one set to *Osallistun* (calendar) and one to *Ei vastausta* (weekly poll). Add secrets `MYCLUB_ICS_URL` (Osallistun links) and `MYCLUB_POLL_ICS_URL` (Ei vastausta links), one line per child: `Name|https://…`.
3. For the Monday sign-ups: `MYCLUB_USERNAME` and `MYCLUB_PASSWORD`.
4. Run helpers **myclub-check** and **attendance-preview**: it lists each child's next events.

## 6. Outlook (15 min)
1. Sign in at https://entra.microsoft.com with your Outlook.com account > App registrations > New registration. Name "Henri mail assistant", **Personal Microsoft accounts only**, no redirect URI. (If it asks for a free Azure sign-up first, do it or tell Claude.)
2. Authentication > *Allow public client flows* = Yes.
3. API permissions > Add > Microsoft Graph > Delegated: `Mail.ReadWrite`, `MailboxSettings.ReadWrite`, `offline_access`. Not `Mail.Send`.
4. Copy the Application (client) ID from Overview into secret `OUTLOOK_CLIENT_ID`.
5. Run helper **outlook-login**, open the running job's log, go to https://microsoft.com/devicelogin and enter the code shown. The token is stored encrypted; it is never printed.
6. Run helper **outlook-test**.

## 7. Switch on (2 min)
1. Actions tab: if GitHub asks, enable workflows.
2. Run **Family agent** with `force` = `myclub,outlook,wilma,digest`: the first digest arrives in the group. After that it runs by itself (06:45 daily, 12:00/16:00 school alerts, Sunday 19:00 week ahead).
3. Run helper **check**: every secret you set shows ✓.

## Decisions (defaults are already built in; reply in the thread to change)
- Weekend digest time: 06:45 like weekdays, or later (e.g. 08:30)?
- Add your partner to the Telegram group? (Just add them; nothing to configure.)
- Grades in the digest? Default **no**; they are never sent to Telegram either way.
- Bills: shown in the family digest, or only in your private chat with the bot? Default: private chat if you set `TELEGRAM_PRIVATE_CHAT_ID` in step 2, otherwise the family digest.
- Digest language: English or Finnish (`digest.language` in config).
