# Velora Tracker

This app is the first executable slice of Phase 9.

It provides a small Node 20 ESM service that:

- reads GitHub and Discord credentials from the environment
- exposes a health endpoint for local checks
- reads the live VeloraCSS Team Planning project from GitHub Projects on demand
- accepts GitHub webhook payloads with optional signature verification
- accepts Discord interactions with Ed25519 signature verification
- normalizes incoming project-item state into the canonical tracker shape
- persists mapping and audit state to a local JSON file in Node mode and can persist the same state to Cloudflare KV in Worker mode
- exposes Discord command definitions for the tracker board and settings workflow

## Requirements

- Node 20+
- environment variables provided to the process at runtime

## Configuration

`tracker/.env.example` is the current template for local configuration:

- `PORT`
- `GITHUB_WEBHOOK_SECRET`
- `GITHUB_TOKEN`
- `GITHUB_ORG`
- `GITHUB_PROJECT_NUMBER`
- `DISCORD_PUBLIC_KEY`
- `DISCORD_APPLICATION_ID`
- `DISCORD_BOT_TOKEN`
- `DISCORD_GUILD_ID`
- `DISCORD_OPERATOR_ROLE_IDS` (optional comma-separated role IDs allowed to use dashboard controls; if omitted, Discord admin/mod permissions are used)
- `TRACKER_STORAGE_MODE` (optional: `auto`, `file`, `memory`, or `kv`)
- `TRACKER_STORAGE_PATH` (optional local JSON state file path for Node mode)

The scaffold reads raw process environment variables only. Copying `.env.example` to `.env` is not enough unless your shell or process manager loads that file first.

Storage defaults:

- local Node mode uses file-backed persistence at `tracker/.data/tracker-state.json` when `TRACKER_STORAGE_MODE` is left as `auto`
- Cloudflare Worker mode uses the `TRACKER_STATE_KV` binding when present and falls back to memory if you leave `TRACKER_STORAGE_MODE=auto` without binding KV
- set `TRACKER_STORAGE_MODE=memory` when you explicitly want ephemeral state during local debugging

## Run locally

```bash
cd tracker
npm start
```

For auto-reload during local work:

```bash
cd tracker
npm run dev
```

To run the Cloudflare Worker locally once Wrangler is installed:

```bash
cd tracker
npm run worker:dev
```

To inspect the current Discord command payloads without starting the server:

```bash
cd tracker
npm run commands:preview
```

To register the current command set with Discord:

```bash
cd tracker
npm run commands:register
```

Current command names:

- `tracker`
- `projects`

Current subcommands:

- `board` with `status` and optional saved `project` key
- `settings show`
- `settings set`
- `settings use`

The legacy `tracked-project-view` route is still accepted by the app for compatibility, but the new command set must be registered before Discord will show `tracker` or `projects` in the slash-command picker.

## Always-on hosting

If you do not want to keep a local terminal and `cloudflared` open, deploy `tracker/` as a Cloudflare Worker.

This repo now includes `tracker/wrangler.toml` and `tracker/src/worker.js`, which run the same tracker handler used by the local Node service.

Recommended Cloudflare setup:

1. In Cloudflare Workers, create a Worker from this GitHub repo instead of deploying the Hello World sample.
2. Point the Worker at the `tracker/` directory.
3. Add these environment variables to the Worker:
	- `GITHUB_WEBHOOK_SECRET`
	- `GITHUB_TOKEN`
	- `GITHUB_ORG`
	- `GITHUB_PROJECT_NUMBER`
	- `DISCORD_PUBLIC_KEY`
	- `DISCORD_APPLICATION_ID`
	- `DISCORD_BOT_TOKEN`
	- `DISCORD_GUILD_ID`
	- `DISCORD_OPERATOR_ROLE_IDS` (optional)
4. Add a KV namespace binding named `TRACKER_STATE_KV` so mappings and audit logs survive Worker cold starts.
5. If you want the Worker to fail fast when KV is missing, set `TRACKER_STORAGE_MODE=kv`.
6. Deploy the Worker.
7. Set Discord Interactions URL to:
	- `<worker-url>/discord/interactions`
8. Optionally set the GitHub webhook target to:
	- `<worker-url>/github/webhook`

`tracker/wrangler.toml` now keeps the non-secret Worker vars in repo config so deploys do not clear the active GitHub org, project number, or storage mode.

After that, Cloudflare keeps the tracker online without a local tunnel.

The repo still includes [render.yaml](../render.yaml) as a fallback web-service path, but Cloudflare is now the preferred no-card deployment target for the tracker.

## HTTP endpoints

- `GET /health`: service status, config presence, command names, storage mode, and current state counts
- `GET /discord/commands`: preview the Discord command registry JSON
- `GET /github/project`: preview the live GitHub Project summary JSON for the configured org and project number
- `POST /discord/interactions`: verify Discord signatures and return the live project summary command response
- `GET /mappings`: inspect the current mapping records
- `GET /audit`: inspect recent audit entries
- `POST /github/webhook`: accept GitHub webhook payloads and update mapping state

## First live setup

To get the Discord app to show the VeloraCSS Team Planning board, provide:

- `GITHUB_TOKEN` with read access to the private VeloraX project and linked content
- `GITHUB_PROJECT_NUMBER=10`
- `DISCORD_PUBLIC_KEY`
- `DISCORD_APPLICATION_ID`
- `DISCORD_BOT_TOKEN`
- `DISCORD_GUILD_ID`

Then:

```bash
cd tracker
npm run commands:register
npm start
```

After that, use `/tracker board` or `/projects board` in the configured Discord guild.

The board command now renders a shared dashboard-style Discord message with:

- a board overview embed
- inline board columns for `Todo`, `In progress`, and `Done` when viewing all lanes
- a refresh button
- a status filter select menu
- a `Manage` button that opens a private writer panel for admins, moderators, or configured operator roles
- a link button back to the GitHub Project board

The settings commands now support per-guild saved project configurations so the same Discord app can switch between multiple repos or GitHub Projects without editing Worker env for every change.

`/tracker settings set` or `/projects settings set` stores a named project key with:

- GitHub org
- GitHub project number
- optional label
- optional `make_active` flag

`/tracker settings use` switches the active saved project for later board and manager flows.

`/tracker settings show` displays the active project and the saved project list for the current guild.

The writer panel currently supports:

- creating draft items from a Discord modal
- changing status for any visible project card
- changing or clearing priority for any visible project card
- editing title, notes, driver, and target date for draft items
- deleting draft items from the GitHub Project board

Manager controls are now stateless across Discord component interactions, so the same writer flow works in the local Node server and the Cloudflare Worker runtime.

Readers can still view the shared dashboard without getting write access to GitHub.

## Current limitations

- Worker state still resets if you run without the optional `TRACKER_STATE_KV` binding or force `TRACKER_STORAGE_MODE=memory`
- the shared public dashboard does not auto-refresh itself yet after write actions; use Refresh until message mapping is added
- outbound GitHub Project mutations exist for the first manager-panel slice, but iteration, size, linked issue title edits, and automatic shared-dashboard refresh are still incomplete
- Discord message mapping and loop prevention are not implemented yet
- webhook normalization is intentionally broad until live payload samples are wired in
- if you change the slash-command schema, you must re-run `npm run commands:register` with `DISCORD_APPLICATION_ID` and `DISCORD_BOT_TOKEN` loaded locally; Worker runtime secrets alone do not update Discord's registered commands
