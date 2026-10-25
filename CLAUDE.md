# Family agent

- Live system: the UpCloud server runs every job and holds the only current state. Rebuild steps and the file map: `server/README.md`. Agents, bots and deploy steps: `openclaw/README.md`
- Live state: read it before you tell Henri a step or say something is fixed. `server/check.sh` (status, logs, mem) on the server, the GitHub API for repos and keys, the code for what a tool allows. Send Henri one version of a step, never a correction a minute later
- "Fixed" means tested end to end on the server, the way Henri would hit it
- One owner per system: the project thread "Always-on Telegram agent options" owns server changes. Other threads send it the change instead of running it
- OpenClaw reverts hand-edited config. Change it with `openclaw config set` / `config patch --file server/*.patch.json5`
- GitHub workflows `tick.yml` and `setup.yml` stop unless repo variable `LIVE_RUNNER` is `github`. Push the server's state before ever setting it
- Laptop (Machina) permissions for server work: `server/laptop/`, installed with `install.ps1`
- The mail tool replies only to the original sender and never to Henri's own address, so send-tests need mail from another account
