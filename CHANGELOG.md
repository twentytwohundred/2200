# Changelog

All notable changes to 2200 are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions follow calendar versioning: `YYYY.M.D` (the UTC date of the cut, no leading zeros, at most one release per day), so an operator can read at a glance how far behind they are. Versions before 2026.6.12 followed semver; `0.1.0` below was never published.

## [Unreleased]

## [2026.616.2141] ... 2026-06-16

### Fixed

- **The installer now tells you how to upgrade Node instead of dead-ending.** When `install.sh` finds Node older than 22, it used to just say "upgrade Node, then re-run" with no how. Now it detects the machine's actual Node manager and prints the exact command: `nvm`/`fnm`/`asdf` if present, else Homebrew (macOS) or the NodeSource one-liner for apt/dnf (Linux), else an nvm-bootstrap + nodejs.org fallback. POSIX `sh`, verified against `dash`.

### Changed

- Dependency bumps merged from Dependabot: commander 14 → 15, react-easy-crop 5 → 6, plus a grouped batch of 10 minor/patch updates. `verify:all` green across the combination (this release brings the published package back in line with `main`).

### Added

- **First-run install now offers a local / self-hosted model, key optional.** The installer's provider step previously only took cloud API keys (or Grok sign-in); pointing 2200 at a local OpenAI-compatible server (Ollama, LM Studio, vLLM, llama.cpp) was deferred to Settings. Now "Local (Ollama / LM Studio / vLLM)" is a first-run choice: paste a base URL (e.g. `http://localhost:11434/v1` or a tailnet host like `http://100.x.x.x:8000/v1`) and **leave the key blank for keyless** ... a LAN/tailnet server is authed at the network layer ... or paste a key if the server requires one. The endpoint is validated against its `/v1/models` (no `Authorization` header sent when keyless), with the same save-anyway-on-network-error path as cloud keys. Writes `LOCAL_BASE_URL` (+ `LOCAL_API_KEY` only when given). Grok/OAuth remains the preferred path; cloud-key and local sit alongside it. (The web Settings → Endpoints panel already supported local endpoints with an optional bearer; this brings the CLI installer to parity.)

## [2026.616.1830] ... 2026-06-16

### Added

- **Slack connector ... brings Slack to Discord/Telegram parity.** Slack previously had only the `slack_api` tool (an Agent could send + poll), but no connector ... a human couldn't DM the Agent and have it wake. Now each Agent gets its own Slack bot over **Socket Mode** (a WebSocket; no public URL, like Telegram's long-poll). DM the Agent or @-mention it in a channel and it wakes and replies with its own identity. The gateway is dependency-free (raw Web API + the Node global `WebSocket`), so it bundles into the npm package. Setup needs two tokens ... an app-level token (`xapp-…`) for the socket and a bot token (`xoxb-…`) for sending ... both sealed to the Agent's vault. DMs open by default, channels require an @mention. Adds the `slack_send` baseline tool (distinct from the `slack_api` passthrough).

## [2026.616.1748] ... 2026-06-16

### Added

- **Telegram connector ... per-Agent bots, the most-used self-hoster chat surface.** Each Agent gets its own Telegram bot (create one with @BotFather, paste the token, message it). A human can DM the Agent ... or add it to a group ... and the Agent wakes and replies with its own identity, the same Discord-grade experience. The gateway is dependency-free (raw Bot API over `getUpdates` long-polling + `sendMessage`, no SDK), so it bundles into the npm package and runs behind NAT with no public URL. Install it per-Agent from the Extensions Store; the bot token is sealed to that Agent's vault. DMs are open by default (a personal bot's @username isn't discoverable); groups require an @mention. Long replies auto-chunk at Telegram's 4096-char limit, and negative group chat ids are handled throughout. Adds the `telegram_send` baseline tool.

## [2026.616.1702] ... 2026-06-16

### Fixed

- **The OpenClaw credential sweep no longer vaults `${ENV_VAR}` interpolation references.** A dry run against a real OpenClaw config showed `models.providers.*.apiKey` hold `${XAI_API_KEY}`-style references (the actual value lives in the `env` block, already captured), not literal keys ... so the sweep was sealing useless placeholder strings. Pure `${...}` values are now skipped.

## [2026.616.1518] ... 2026-06-16

### Added

- **OpenClaw migration now vaults every credential, not just the ones 2200 uses today.** A migration sweeps every secret-shaped value in `openclaw.json` ... the whole `env` block plus every `apiKey`/`token`/`secret`/`password` leaf wherever it lives (`models.providers.*`, `skills.entries.*`, `channels.*`, `gateway.auth`, `plugins.*`) ... and seals each into the migrated Agent's encrypted per-Agent vault (`oc-<source-path>` names, e.g. `oc-channels-discord-token`). So nothing an OpenClaw user had is lost on the way over; a future 2200 integration can pull what it needs by name. The functional keys (LLM, web search) still also land in `runtime.env` so they work immediately ... the vault is the complete archive on top. The migration report and `2200 credential list <agent>` show what was sealed. Exact secret-name matching means non-secrets like `maxTokens` are never swept. (The vault is sealed per-Agent and not exposed to the Agent/LLM; hardening the vault's master key is tracked as a pre-public item.)

## [2026.616.1447] ... 2026-06-16

### Changed

- **Web search keys now apply without a restart.** The `web_search` tool reads its keys (`BRAVE_API_KEY`, `GEMINI_SEARCH_API_KEY`, `GOOGLE_SEARCH_API_KEY` / `GOOGLE_SEARCH_CX`, `WEB_SEARCH_PROVIDER`) from `runtime.env` at search time, not just at spawn. Paste a key in Settings → Web Search and the next search uses it ... no `2200 daemon restart`, no Agent restart. Previously a freshly-added key sat unused until the whole fleet was bounced (an Agent only read its environment once, at start). The Settings save confirmation and the API's `restart_required` flag are updated to reflect this. (A key _removed_ from the file still takes effect on the next restart ... the rarer case.) The runtime.env path can be overridden for the search read via `TWENTYTWOHUNDRED_RUNTIME_ENV`.

## [2026.616.1257] ... 2026-06-16

### Added

- **Gemini web search (Google-Search grounding), for full OpenClaw parity.** `web_search` now also supports Gemini grounding ... a single Gemini API key, no `cx`. This is the provider OpenClaw actually uses for its "google" search (grounding, not the Custom Search JSON API), so an OpenClaw migration now carries that key straight into 2200, from OpenClaw's real config path. Settings → Web Search gains a Gemini card alongside Brave and Google. Note: Gemini grounding is billed per query beyond a small free tier.

### Changed

- **OpenClaw search migration now maps providers faithfully.** It reads each provider's key from OpenClaw's real plugin path and maps `gemini → gemini` / `brave → brave` (the previous `gemini → google` was the wrong API). Providers 2200 doesn't implement yet (grok, perplexity, exa, ...) carry nothing and are named in the migration report instead of silently pinning a dead provider.

### Fixed

- The migration report no longer claims "your key carried" when OpenClaw named a provider but had no key set ... it now tells the truth (nothing carried) and points to Settings.
- Settings → Web Search: the Google card no longer pins Google as the active provider unless both the key and the engine id (`cx`) are present (a key-only pin was silently inert), and the engine-id field no longer holds a stale value across background refreshes.

## [2026.616.9] ... 2026-06-16

### Added

- **Web search is now a real, configurable feature: Brave + Google, bring-your-own-key.** Building on the Brave backend, `web_search` now also supports Google Programmable Search, with a provider resolver (pin one via `WEB_SEARCH_PROVIDER`, else Brave preferred then Google). A new **Settings → Web Search** panel lets you paste a Brave key or a Google key + engine id, see which provider is active, and prefer one when both are set — no runtime.env editing. And an OpenClaw migration now carries your search keys + provider choice over (mapping OpenClaw's `gemini`/`google` to Google), the same as it does LLM keys.

## [2026.615.2259] ... 2026-06-15

### Added

- **Web search works.** `web_search` was a stub that always returned empty results with "no provider configured", so no Agent could research the web. It's now backed by the Brave Search API: set `BRAVE_API_KEY` in `~/.config/2200/runtime.env` (free tier ~2000 queries/mo at brave.com/search/api) and restart the daemon, and Agents get ranked `{url, title, snippet}` results. With no key set, the tool returns an actionable status explaining how to enable it instead of a silent empty. Network/HTTP errors surface as status, never throw. (xAI's keyless Live Search was the original plan but xAI deprecated it; an in-product setup affordance for the key, and a Grok-native path on xAI's new Agent Tools API, are follow-ups.)

## [2026.615.2043] ... 2026-06-15

### Added

- **The Build-an-Agent interview now reads what you actually said.** The suggestion engine only fired for three scripted archetypes (email / project / ops); a free-form Agent (e.g. a daily-playlist publisher) produced a great interview but 0 suggested schedules, tools, and capabilities. A new LLM extraction pass runs when the interview finishes and (1) parses the stated cadence into a real, validated cron + IANA timezone ("6:30am EDT daily" → `30 6 * * *`, `America/New_York`) and (2) extracts the external services the Agent needs that 2200 has no connector for yet (Spotify, Instagram, X, ...), records each as a catalog gap (a real demand signal for what to build next), and surfaces them in the preview as "needed integrations" instead of a blank "0 tools". Best-effort: a malformed model response never blocks the preview. (Schedules are still suggested, not auto-written — auto-applying on confirm is a follow-up.)

## [2026.615.1958] ... 2026-06-15

### Fixed

- **A new update no longer gets hidden behind a finished upgrade card.** The upgrade status is persisted and survives the daemon restart, so a completed (or failed) upgrade lingered and took render priority in the System Update tile — hiding the "Upgrade to <new>" button when a newer release landed (you'd see "UPDATE AVAILABLE" up top with no way to act on it). Now an actively-running upgrade still shows its live progress, but a newly-available update supersedes a finished card so the Upgrade action surfaces; a finished card otherwise stays for post-upgrade confirmation / failure visibility. The upgrade engine itself was never affected.

## [2026.615.1813] ... 2026-06-15

### Fixed

- **The Build-an-Agent picker shows only configured connections.** It listed every provider with a credential OR a keyless fallback, so the `local` (Ollama / LM Studio) placeholder always appeared even when real connections were configured. It now shows only providers with a credential actually set (plus custom endpoints), falling back to the keyless providers only when nothing else is configured (so a cold-start instance can still build an Agent).

## [2026.615.1751] ... 2026-06-15

### Fixed

- **The Build-an-Agent interview now defaults to a provider you have credentials for.** It used to default the provider/model to the first pickable option — a keyOptional provider (OpenRouter) with a free-text model box — even when the instance already had configured credentials (migrated API keys, an xAI/SuperGrok sign-in). It now ranks the default: a configured provider an existing Agent already uses (matching the fleet) → a configured subscription credential → any provider with a key set → the first pickable option. So a migrated operator lands on, e.g., the same xAI/Grok provider their migrated Agent uses, with a real model, instead of OpenRouter + free text.

## [2026.615.1725] ... 2026-06-15

### Added

- **Recover web access by pasting your token.** When the web app has no token, or the stored one no longer authenticates (after `2200 web token rotate`, or an instance reset), it now shows a paste-your-token screen instead of a broken app — paste the value the CLI printed and you're back in, no `?token=...` URL surgery. A non-auth failure (daemon down / network) is not treated as a token problem, so a valid token is never discarded over a transient outage.
- **`2200 web token rotate` / `issue` / `status` print the access URL.** They used to print only the bare token; now they print the clickable Tailscale/LAN/localhost URL(s) with the token embedded — the same block `2200 setup` ends at — so a rotate hands you a URL to open, not a token to graft into a URL yourself.

## [2026.615.1630] ... 2026-06-15

Connectors ship to production, and OpenClaw migration carries Discord over.

### Added

- **Connectors now run from a published install.** The connector/extensions subsystem was dev-only: the gateway launched only from a repo `workspace` via `tsx`, and neither the connector app nor the catalog shipped in the npm package — so on a normal install the Discord gateway could not start (inbound Discord was silently broken). Each connector's gateway is now esbuild-bundled into one self-contained CommonJS file at `dist/connectors/<id>/gateway.cjs` (discord.js inlined), the catalog ships in the package, and `GatewayManager` runs the bundled gateway with plain `node` (dev still uses workspace + `tsx`). Verified in a clean container: the shipped gateway connects to Discord.
- **The OpenClaw migration carries your Discord connection.** Instead of leaving you to find a bot token and re-paste it, an interactive migration brings Discord over automatically and steps OpenClaw down so exactly one Agent answers. It explains up front (Agent + Discord come over; OpenClaw is disabled after a verified migration), then does an **ordered cutover with rollback**: stop OpenClaw (frees the bot token — the same token live in two places means both Agents answer), wire 2200's Discord, verify the gateway actually reached Discord, and on failure restart OpenClaw so you are never left dark. The migration also restarts the daemon first so the just-migrated LLM keys are loaded (the Agent can answer immediately). Verified end-to-end on a real box: install → migrate → OpenClaw disabled → 2200 live on Discord as the same bot, sole holder of the connection.

### Fixed

- **`disableOpenClaw` now disables the real systemd unit** (`openclaw-gateway`, not `openclaw`), so a stopped gateway does not restart on the next boot and put two of the same bot back on Discord. (Found live: the old name never matched, so OpenClaw was stopped-but-enabled.)

## [2026.615.1332] ... 2026-06-15

### Fixed

- **The one-line installer no longer aborts before setup on a session with no controlling terminal** (headless SSH `ssh host '...'`, CI, cron). `install.sh` decided whether to reattach `/dev/tty` for the one interactive question with `[ -r /dev/tty ]`, which passes the permission test even when there is no controlling terminal; the subsequent `2200 setup < /dev/tty` then died with `ENXIO` ("No such device or address"), killing the install right before setup. The check now actually _attempts_ the open, inside a subshell so dash's special-built-in redirection-error exit can't take the whole script down, and falls back to a fully non-interactive `2200 setup`. Verified end-to-end from scratch on a real Ubuntu/dash box over headless SSH: install → OpenClaw migration → web URL, exit 0. (Installer script only; not part of the npm package. 2200.ai must redeploy install.sh to pick it up.)

## [2026.615.1301] ... 2026-06-15

### Fixed

- **The web app is now actually served.** The published package never included the built web UI, so `2200 web` (and the URL setup prints) showed only "The web app has not been built yet" with a bare API. The package now bundles the built web app into `dist/web` at pack time (a new `bundle:web` step in `prepack`, since `dist/` is what ships and tsup cleans it), and the server's static-dir resolver finds it robustly regardless of which bundle the server code was inlined into. Verified in a container: a fresh install serves the real app (`<title>2200</title>` + the JS/CSS assets), not the placeholder.

## [2026.614.1910] ... 2026-06-14

### Added

- **Setup asks whether to disable the migrated OpenClaw instance** (and acts on it). After bringing an OpenClaw Agent over, setup now offers to disable the source OpenClaw so it stops running alongside 2200 — it is **never deleted**, and we **never auto-disable**: the question only appears when a terminal is attached (the installer reattaches `/dev/tty` for it), defaults to no, and on yes runs the disable (systemd-user service on Linux, the `openclaw` CLI's gateway-stop on macOS/non-systemd), reporting what happened. With no terminal it just prints the disable command. The migration itself is still automatic (no "migrate now?" prompt on the setup path).

## [2026.614.1856] ... 2026-06-14

### Fixed

- **The web URL printed by setup is now actually reachable.** When a daemon was already running bound to loopback (`127.0.0.1`) from a prior `2200`/`daemon start`, setup's idempotent path printed the LAN/Tailscale URL without rebinding — so the URL refused/timed out. Setup now detects a loopback-bound daemon (reading the daemon's actually-bound host from its log) and restarts it onto `0.0.0.0` so the printed URL works. The LAN bind is also persisted on the idempotent path, not just the fresh one. Verified in a container: a daemon on `127.0.0.1` → `2200 setup` → rebound to `0.0.0.0`, LAN IP returns HTTP 200.
- **Firewall hint in the access block.** When a non-localhost URL is shown, setup now notes that an OS firewall (e.g. the macOS application firewall) can block incoming connections from other devices, and where to allow Node.

## [2026.614.1828] ... 2026-06-14

### Added

- **Tailscale-aware access URL.** When the machine is on a Tailscale network, setup now detects the tailnet IP (the 100.64.0.0/10 address) and shows `http://<tailscale-ip>:2200/?token=...` as the recommended URL — reachable from any of your devices anywhere, not just the local subnet — with the LAN IP and localhost listed as alternates. No prompt: the web server binds to all interfaces, so every URL resolves and you click whichever fits. A machine not on a tailnet just sees the LAN + localhost URLs as before.

## [2026.614.1818] ... 2026-06-14

One fluid install path: paste the command, end at a web URL.

### Added

- **`2200 setup`** — a one-shot, non-interactive setup the installer runs as its final step, so `curl -fsSL https://2200.ai/install.sh | sh` flows straight through to a running 2200 with **no intermediate "now run this" stops**. It inits `2200_HOME`, mints a user identity (display name defaults to `$USER`, renamed later in-app), starts the daemon, auto-migrates OpenClaw when `~/.openclaw` is present, and prints the access block. Idempotent: a second run just re-surfaces the URL.
- **The setup ends at a LAN web URL with the token embedded**: `http://<lan-ip>:2200/?token=<bearer>` (the web app reads `?token=` from the URL, persists it, and strips the param), with the localhost fallback and the bare token shown beneath. The web server now binds to the LAN (`0.0.0.0`, persisted) so the URL is reachable from a phone or another laptop — most installs live behind a private IP, not localhost. Every route still requires the bearer token.

### Changed

- **A migrated OpenClaw user is no longer walked through building a "first Agent"** they already have — setup (and the interactive `2200` first-run) detect the migration and instead say "your migrated Agent is already there."
- **The interactive `2200` first-run also ends at the web URL** now, not at a `2200 agent build` instruction.
- **The installer's npm-prefix fix auto-applies with narration** instead of a yes/no prompt (it's reversible install plumbing, and a stop on the one-line install path is friction). `--no-prefix-fix` opts out; `--no-setup` installs the CLI only.

## [2026.613.2149] ... 2026-06-13

Update-mechanism hardening, for click-update dogfooding.

### Fixed

- **Web "click Upgrade" was broken** and now works. The daemon resolved the detached upgrade helper relative to its own bundled location, but the trigger code is inlined into the supervisor bundle (`dist/runtime/supervisor/`) while the helper ships at `dist/runtime/install/` — so every web upgrade returned "runner not found". The resolver now walks up to the dist root and finds the helper at its real path. **Note:** an instance already running an older build still has the broken web button; update it once via `2200 update` (CLI) to land on this version, after which the Settings → Upgrade button works.
- **CalVer leading-zero could break npm publish.** A release cut in the morning via `date +%H%M` produces e.g. `0830`, which is invalid semver (no leading zeros) and npm rejects. The release workflow now validates semver-validity up front with a clear message. The scheme is `H*100+MM` with no padding (08:30 → 830, 00:05 → 5, 14:45 → 1445).

### Changed

- **In-flight guard on the upgrade trigger.** A second "Upgrade" click while one is already running returns `409 already-in-progress` instead of spawning a second runner racing the first. A status that hasn't advanced for over 3 minutes is treated as a crashed runner, so a fresh attempt can recover.
- **Settings update tile refreshes promptly.** It now polls the published version every 60s and adds a "Check now" button, so a freshly-published release appears within a minute (was up to 5).

### Verified (no change needed)

- Version comparison is numeric, so CalVer orders correctly and a multi-version skip installs straight to latest. Identity files carry a complete lazy migrator chain (`0→1→2→3→4→5`), so skipping 2–3 versions migrates them correctly on load. The upgrade SIGTERMs the daemon (full stop), so the new daemon restarts every Agent on the new code ("reload everything"). **Forward-discipline note:** non-identity on-disk schemas are all at v1 with no migrator chain yet — safe today, but the first one to bump must add a chain (the identity migrators are the template).

## [2026.613.1445] ... 2026-06-13

The first impression, rebuilt: a premium branded installer and zero-flag OpenClaw migration.

### Added

- **Premium installer (`install.sh` rewrite).** Brand-accurate "green-for-alive" terminal UI: a block `2200` wordmark + green-dot `green for alive` tagline in truecolor `#22c97a` (256-color fallback), a braille install spinner over captured npm output, and a `✓`/`✗`/`!` glyph triad matching the app's fleet-state palette. Correctly gated: the full art renders only on an interactive UTF-8 terminal; piped/CI output is a clean one-liner with zero escape leakage; `NO_COLOR`/`FORCE_COLOR` are honored (presence-based). Validated in clean `node:22` containers across the piped, non-root prefix-fix, and full TTY/truecolor paths.
- **Zero-flag OpenClaw auto-migration.** The installer detects `~/.openclaw` and seeds the banner (non-TTY safe); the bare-`2200` first-run wizard then offers to migrate **automatically, only when OpenClaw is present** — a blank user never sees it, and no flag is required. It runs through the daemon's `cli.build.from-handoff` RPC (no migrate-vs-daemon state-file race), copies the OpenClaw LLM provider keys into `runtime.env` so the Agent works without re-auth, and prints the migration report + post-migration checklist + disable-not-delete guidance. Every failure path is non-fatal.
- **Post-migration checklist** appended to the OpenClaw migration report (printed and in the Agent's continuity note): start the Agent, confirm an LLM key, rebind the model if the provider didn't map, re-wire channels, review the budget cap, disable the source.

### Security

- **`collectOpenClawLlmEnv` is now an explicit LLM-provider allowlist**, not a `_KEY$`/`_TOKEN$` suffix heuristic. It no longer sweeps up unrelated secrets that share an env block (`GITHUB_TOKEN`, `AWS_SECRET_ACCESS_KEY`, `STRIPE_API_KEY`, channel tokens) — only credentials for LLM providers 2200 understands are copied.
- **`upsertRuntimeEnvKey` enforces `0600` on every write.** `writeFile`'s mode only applied on file creation, so an existing `runtime.env` kept its prior (possibly looser) permissions while provider secrets were written into it. Now chmod'd explicitly on every write.

### Fixed

- **Eight installer correctness bugs** surfaced by an adversarial review: `--help` was broken under `curl|sh` (it `sed`'d `$0`, which is the shell name over a pipe); a `null` npm prefix could send the script editing dotfiles against a phantom path; the bash banner told users to `source ~/.bashrc ~/.profile` (which only sources the first file); the npm-prefix-change consent now actually prompts via `/dev/tty` on the `curl|sh` path (the old `[ -t 0 ]` guard was always false there, so it silently edited shell init files); plus guarded command substitutions under `set -e`, a numeric Node-version guard, exact-line PATH idempotency, macOS `.bash_profile` precedence, cursor restoration on every exit path including `SIGHUP`, a `--version=` empty guard, and a private umask on the temp-log fallback.
- **Release publish is idempotent**: the npm publish step skips cleanly when the version is already on the registry instead of failing late with a 403/409.

## [2026.612.2230] ... 2026-06-12

Third cut of the day: the OpenClaw migration adapter ships.

### Added

- **OpenClaw migration adapter (Epic 5 Phase B).** `2200 agent migrate --from-openclaw <dir>` takes an OpenClaw home (the directory with `openclaw.json`, usually `~/.openclaw`) and produces a working 2200 Agent with continuity: `SOUL.md` becomes the Identity body verbatim (the Agent keeps its voice, via the new optional `persona_body` handoff field), `IDENTITY.md` drives names, daily `workspace/memory/*.md` files bulk-import into the brain, operating docs (`USER`/`AGENTS`/`TOOLS`/`HEARTBEAT.md`) land as `openclaw-import`-tagged brain notes, enabled cron jobs map onto 2200 schedules (5-field cron + IANA timezone, 1:1), and the primary model binding carries over when the provider exists in 2200's catalog. LLM provider API keys are copied from the OC config into `runtime.env` by default (existing 2200 keys are never overwritten; `--no-migrate-llm-keys` opts out) so the migrated Agent works the moment it starts. Channel tokens never migrate ... the printed **migration report** (also appended to the Agent's continuity note) maps each unmigrated item to its 2200 path, and the flow ends with instructions to disable ... never delete ... the source OC instance so the operator isn't running two fleets. `--validate` previews the whole thing without touching state. Validated end-to-end against a live OpenClaw 2026.4.11 instance. Spec: wiki `05-phase-b-openclaw-adapter`.
- **Handoff schema: `persona_body` + schedule import.** Migration handoffs can now carry a persona (used verbatim as the Identity body) and schedule entries (imported via the scheduler after registration; per-entry failures are non-fatal and reported). The Phase A `schedules: []` constraint is lifted exactly as its schema comment planned.

## [2026.612.2032] ... 2026-06-12

Phase 1 hardening for first production installs. Second cut of the day ... the first same-day release under the extended CalVer scheme.

### Fixed

- **Pub owners derive from the operator's identity, never a baked-in default.** `composePubMd` requires an owner; `Supervisor.createPub` reads the user identity's pub handle and fails loud with a fix-it message when no identity exists yet. Previously every install's pubs were created with `owner: doug`. (#271)
- **Hardcoded `doug` swept from every shipped string**: starter-pack Agent guidance now uses `@<operator-handle>` and "the operator", agent-loop prompt examples, the `task_await_response` tool description, CLI help text, the web Embassies placeholder, and the model-catalog notes field are all neutral. Test fixtures moved to `alice`/`operator`. Dated design-decision attribution comments are deliberately retained as project history. (#271)
- **Two test flakes root-caused**: the scheduler-integration test read the schedule file inside the enqueue-before-persist write gap; the pub-client test asserted `roomState()` synchronously while the `room_state` frame was still in flight behind the welcome handshake. Both now poll the actual condition. (#272)

### Security

- **Timing-safe bearer comparison** in the web token store's `findByValue` (was `===`, which leaks prefix-match timing). Same `timingSafeEqual` discipline the connector listener already uses. (#271)
- **The permission evaluator and connector inbound router now have test coverage** (19 + 21 tests; both were previously untested). The router suite pins the secure defaults: unknown DM senders go to operator pairing, unknown groups are blocked, group activation requires a mention, self-echoes never wake an Agent, and a platform's `mentioned: false` beats substring matching. (#272)

### Added

- **Operator runbook sections in the README**: what `2200 update` does to a running fleet (stop → install → restart, checkpoint resume for non-destructive tasks, rollback attempt on failure), backup/restore for the two state directories, and a troubleshooting quick-reference. (#272)

## [2026.612.1935] ... 2026-06-12

First release published to the npm registry. Versioning extends to `YYYY.MDD.HHMM` (month+day packed into the minor slot, UTC time of the cut in the patch slot) per the v2 decision ... npm rejects four-segment versions, so `2026.612.1935` is the three-slot form of "June 12 2026, cut at 19:35 UTC". Same-day releases are now possible ... this cut supersedes the same-day `2026.612.1857` attempt, which npm's name filter rejected and which never reached any registry.

### Changed

- **Package renamed to `@twentytwohundred/2200-cli`.** npm's registry blocks new all-numeric package names ("That word is not allowed"), confirmed empirically: a minimal stub under `@twentytwohundred/2200` was rejected while `@twentytwohundred/2200-cli` and `@twentytwohundred/cli` both published cleanly. The `2200` binary name, the `curl https://2200.ai/install.sh | sh` one-liner, and all on-disk paths are unchanged ... only the npm package name moved. npm offers no allowlisting path for blocked names (their name-claim process covers trademark disputes only), so `2200-cli` is the permanent package name. `@twentytwohundred/cli` is held as a claimed alias.

### Fixed

- **`pnpm verify` builds before testing.** The release workflow's first-ever run exposed a deterministic ordering bug masquerading as the old chaos-test flake: `verify` ran tests before build, but `supervisor-bounce-survival` spawns a real Agent from `dist/runtime/agent/bootstrap.js`, which doesn't exist on a fresh runner. The Agent spawn died instantly and the registration predicate timed out at 20s ... three consecutive release failures. `ci.yml` was already immune via an explicit Build-before-Test step; local `verify` also no longer silently tests a stale `dist/`. (#268)

## [2026.6.12] ... 2026-06-12

First published release ... the first 2200 version to reach the npm registry and GitHub Releases, and the first under calendar versioning.

### Fixed

- **CLI sources `runtime.env` and `oauth-apps.env` on every invocation** via a commander `preAction` hook, so any command that reads a provider key (`agent build` auto-pick, `oauth login` cred checks, direct `resolveProvider` calls) works from a bare shell instead of failing despite correctly stored keys. Live regression 2026-06-03. (#265)
- **`Supervisor.stopAgent` kills orphaned Agent processes when the tracked map is empty**, so a stop request can no longer leave an untracked Agent process running. (#263)

### Added

- **Paste-a-key provider setup in first-run.** The first-run wizard offers an API-key path alongside the SuperGrok OAuth sign-in, so a new install can bind any supported provider without leaving the terminal. (#264)

- **Embassy arc cleanup pass (Phase 2 / PR-B6).** Final piece of the embassy/shelf arc. Completes the `connector.embassy_*` audit family and validates the full chain end-to-end with an integration test.
  - **Three new audit events** (normal tier — operator-noteworthy lifecycle):
    - `connector.embassy_registered` — fires when an embassy / conduit binding is established (atomic or two-step path).
    - `connector.embassy_retired` — fires when a conduit is retired and stops routing.
    - `connector.embassy_shelf_approval_resolved` — fires on operator approve / reject of a pending shelf placement. Decision recorded in extras.
  - **`Supervisor.rejectShelfPlacement`** now reads the pending approval before deleting so it can emit the rejected event with the correct embassy context.
  - **End-to-end chain test** at `tests/runtime/mcp/connector/embassy/chain.test.ts` exercising the locked shape: register embassy → contribute (lands in embassy brain) → embassy autonomous `shelf_place` → embassy `shelf_request_human_placement` → operator approves → `buildShelfPreview` surfaces all items with `self_reflected` + prefix-variation by `source_type` → `applyCollectionTransition` on one-shot transitions to collected → standing item stays pending. Validates both data flow and audit-event flow. Three test cases (full chain, retire fires event, reject fires event).

- **Settings UI for embassies + atomic OAuth-and-embassy registration (Phase 2 / PR-B5).** Operator polish on top of the embassy substrate. The "register a connection to Grok" intent now maps to one Settings flow, not two cascading ones.
  - **`Settings → Embassies`** sub-section: list of registered conduits with mode, external model, embassy agent, registered-at, last-seen-at. Two-step retire confirm (no `window.confirm`). Same idiom as `Settings → OAuth Clients` and `Settings → Work Packages`.
  - **Atomic registration form**: one submit mints the OAuth client + provisions the embassy Agent. Result page shows the full paste block for `grok.com/connectors → Custom` (MCP server URL, Client ID, Authorization/Token endpoints, scopes, Token Auth Method). When mint_secret is enabled the client secret is shown once.
  - **Rollback on failure**: if embassy registration fails after the OAuth client is minted, the client is automatically revoked so operators aren't left with orphaned credentials.
  - **Daemon HTTP routes** (loopback): `GET /api/v1/connector/conduits`, `POST /api/v1/connector/conduits` (atomic), `POST /api/v1/connector/conduits/:id/retire`. Mirror the CLI verbs `2200 connector mcp register|list|retire` plus the atomic variant.
  - **`Supervisor.registerEmbassyAndOAuthClient`** is the new atomic primitive — wraps `registerOAuthClient` + `registerEmbassy` with rollback semantics. Existing CLI verbs continue to use the two-step path.
- **`shelf_pull` MCP tool + `get_fleet_context.shelf_preview` surfacing (Phase 2 / PR-B4).** The moment Grok actually sees the continuity primitive. With this in, the full embassy + shelf + preview + pull + self-reflected + one-shot-collection chain works end-to-end against the real grok.com flow.
  - **`shelf_pull(shelf_item_id)`** new MCP tool. Routes via OAuth `client_id` → conduit → embassy. Returns the full body + provenance summary. For one-shot types (`question`, `research_request`) the type-driven collection transition (PR-B2's `applyCollectionTransition`) fires server-side — same-call-session enforcement of the locked "collected" rule. Standing types stay pending after pull (continuous re-surfacing). Already-collected items return the body without re-firing the transition. Cross-conduit refusal: items attributed to a different OAuth client_id return `unknown shelf_item_id` (threat-model tightening).
  - **`get_fleet_context.shelf_preview`** optional response block. Hard cap 10 inline items + `next_priority_ids` long-tail (next 10 IDs without content). Priority order per spec section 7 verbatim: standing-pending first, then high-priority, then most-recent `ingested_at`, with collected-standing items below pending. Deterministic score formula for reproducible test ordering. Block omitted entirely when the caller has no registered conduit (static-bearer / unregistered OAuth).
  - **`self_reflected`** detection: true when an item's `source.client_id` matches the calling OAuth client. Excerpt is prefixed by a model-readable sentence varying by `source_type`: "the fleet flagged it for your return" (embassy_autonomous) vs "an operator curated it for your return" (human_curated). Stateless-client compatible — no session bookkeeping needed.
  - **Excerpt** is the first 500 chars of the item body, truncated on a word boundary with `...` appended.
  - **Two new audit events**: `connector.embassy_shelf_pulled` (passive; fires on every `shelf_pull`) and `connector.embassy_shelf_preview_surfaced` (passive; once per `get_fleet_context` call with a non-empty preview, counts `items_surfaced` + `self_reflected_count` + `total_pending`). Rest of the `connector.embassy_*` family lands in B6.
- **`propose_work_package` + `get_research_brief` route through the embassy (Phase 2 / PR-B3b).** Fast follow-up to PR-B3 part 1. The remaining two connector tools now respect embassy routing; reads search across the shared brain + every registered embassy so operator workflows (CLI approve, web Settings tile) work without the operator naming a specific embassy.
  - **`writeProposedPackage`** gains an optional `embassyAgent` parameter. When set, the package note lands in the embassy's brain (tagged `relationship-history` + `work-package`) instead of the shared brain.
  - **`Supervisor.proposeWorkPackage`** threads `callingClientId` through and calls `resolveCallingEmbassy` to pick the embassy. The MCP tool plumbs `callingClientId` from `ConnectorMcpServerDeps`.
  - **`readWorkPackage` / `listWorkPackages` / `patchPackageFrontmatter`** search across the shared brain + every registered embassy brain; reads and lookups don't require operator-supplied embassy context. List aggregates with dedup by `package_id`.
  - **`readBrief`** (the read side of `get_research_brief`) searches shared brain first, then every registered embassy. Briefs synthesised after B3 land in the embassy that owns the conduit.
  - **`locatePackageStore`** helper centralizes the cross-store search pattern; same shape adopted in `readBrief` for briefs.
- **`contribute_to_thread` routes through the embassy + one-time pre-embassy note migration (Phase 2 / PR-B3 part 1).** Connector contributions now land in the embassy's brain (tagged `relationship-history`) for OAuth-authenticated callers with a registered conduit. When the first conduit is registered, existing pre-embassy notes are migrated to the new embassy automatically (sentinel-tracked, idempotent).
  - **Routing helper** `resolveCallingEmbassy(home, callingClientId)` — single lookup surface from OAuth `client_id` → conduit → embassy. Returns null for static-bearer callers and unregistered clients; tools fall back to legacy ownerless-note behavior. Records `last_seen_at` on the conduit on every match.
  - **`contribute_to_thread` migrated**: both thread and agent targets route through the embassy when one is registered for the calling OAuth client. Thread anchors land in the embassy's brain (tagged `research-thread` + `relationship-history`); per-Agent contributions land in the embassy's brain too with `target_agent` preserved in extras for cross-reference.
  - **`callingClientId` plumbed end-to-end**: the listener's `/mcp` preHandler stashes the verified OAuth client_id on the request; the per-request MCP server receives it via `ConnectorMcpServerDeps`; tool handlers look up the embassy through the routing helper.
  - **One-time migration** at first-conduit-register time. Migrates research threads + standing briefs from `<shared>/brain/` + per-Agent grok-contributions from every Agent's brain into the embassy's brain. Sentinel at `<home>/state/connector/note-migration-complete.json` guards re-runs; idempotent. Per-Agent contributions retain `target_agent` extras. Operator can force a re-run via `clearMigrationSentinel` (post-retire-and-re-register recovery).
  - **`propose_work_package` and `get_research_brief` migrations** ship in a parallel small PR (B3b) to keep PR-B3 reviewable.
- **Embassy shelf data model + nine internal tools + sensitivity gate (Phase 2 / PR-B2).** Second slice of the embassy/shelf arc. Lays the shelf substrate; the connector tools migrate through it in B3; remote-model surfacing in `get_fleet_context` lands in B4.
  - **Shelf data model** per spec section 5 verbatim. Items live at `agents/<embassy>/brain/shelf/<shelf-item-id>.md`, frontmatter-typed (Zod-validated) with full provenance (`source.client_id` for `self_reflected` detection, `provenance.ingested_at` / `_by` / `chain`). `shelf_item_id` is `shelf_<24 base32>`. Item types are `question`, `context`, `research_request`, `synthesis_prompt`, `agenda`; one-shot vs standing collection semantics per spec section 6.
  - **Nine internal tools** (spec section 8 + the `shelf_read` Grok approved in the final pass), all under the `shelf_` namespace per the runtime's `<namespace>_<verb>` convention. Spec → runtime mapping documented inline:
    - `shelf_place` (spec: `place_on_shelf`) — writes a `pending` item.
    - `shelf_resolve` (spec: `resolve_shelf_item`) — forces `collected`.
    - `shelf_reopen` (spec: `reopen_shelf_item`) — `collected` → `pending`.
    - `shelf_reprioritize` (spec: `reprioritize_shelf_item`).
    - `shelf_remove` (spec: `remove_from_shelf`) — deletes the file.
    - `shelf_list_mine` (spec: `list_my_shelf`) — full bodies; embassy-internal, distinct from the bounded preview that lands in B4.
    - `shelf_read` (new) — single-item full body + frontmatter; embassy-internal pull path.
    - `shelf_curate_from_inbox` (spec: `curate_from_inbox`) — moves operator-curated items to the shelf with `source_type: human_curated`.
    - `shelf_request_human_placement` (spec: `request_human_shelf_placement`) — only path for items needing operator approval.
  - **Sensitivity gate (locked 2026-05-26)**. `shelf_place` rejects `sensitivity: 'private'` at the Zod schema layer (the enum is restricted to `'none'`); `shelf_request_human_placement` is the only path. Operator approval via `2200 connector mcp shelf approve <token>` writes the item with `source_type: human_curated` and the operator's name as curator — the human approval IS the desensitization.
  - **Rate limiting (locked 2026-05-26)**. In-memory rolling 60-second window per embassy. System defaults 20/min soft (audit-only) + 100/min hard (rejects with `ToolDeniedError` reason `placement_rate_exceeded`). Per-embassy overrides on the conduit record's optional `rate_limits` block. Resets on Agent restart.
  - **Five audit event types**: `connector.embassy_shelf_item_placed` (passive, fires on every successful write including post-approval), `_item_resolved` (passive, manual + auto), `_human_approval_requested` (normal, the operator-actionable event), `_item_read` (passive, embassy reads its own shelf), `_rate_threshold` / `_rate_exceeded` (normal / important, burst guard).
  - **CLI verbs**: `2200 connector mcp shelf approve <token> [--operator-name <name>]` and `2200 connector mcp shelf reject <token>` for the human-approval flow.
  - **Dedicated-embassy registration** now defaults `tools:` to include all nine shelf tools so the embassy can actually use the shelf out of the box; attached mode preserves existing tools (operators add explicitly).
  - **Spec→runtime "collected" rule** (per Grok's 2026-05-26 wording): an item is considered collected only when the remote model has received the full (or sufficient) body during the same inbound call session, not when it has only seen a preview. The `applyCollectionTransition` helper enforces type-driven rules: one-shot types → `collected`, standing types stay `pending` after the model pulls.
- **Embassy substrate + conduits registry (Phase 2 / PR-B1).** First slice of the locked embassy/shelf arc (spec: `wiki/inbox/grok/2026-05-23-embassy-shelf-handoff.md`). Lays the substrate; subsequent PRs in the arc layer on top.
  - **`embassy` block on the identity frontmatter** marks an Agent as currently acting as a fleet embassy for an external MCP-speaking model. Records `external_model`, `client_id` (the OAuth client this embassy serves), `mode` (`dedicated` or `attached`), `registered_at`. Optional + additive; existing identity files parse cleanly.
  - **Conduits registry** at `<home>/state/connector/conduits/<client_id>.json`, keyed by OAuth `client_id` per the 2026-05-26 locked decision. The access token at `/mcp` already carries `client_id`, so subsequent PRs route to the right embassy without an extra lookup. Operator-visible projection regenerates at `<shared>/brain/conduits.md` (same pattern as `<home>/state/fleet.md` — rebuildable mirror, never edit by hand).
  - **`Supervisor.registerEmbassy({client_id, external_model, embassy_agent, mode, display_name, ...})`** — validates the OAuth client exists + isn't revoked, ensures no existing conduit for the same client, then either creates a fresh Agent with the embassy identity template (dedicated) or patches an existing Agent's identity with the embassy block (attached). Initializes the embassy's brain subdirs per spec section 4: `shelf/`, `relationship-history/`, `standing-briefs/`, `notes/`. Writes the conduit record + regenerates the shared-brain index.
  - **CLI** under `2200 connector mcp <verb>` per spec section 10:
    - `register --client-id <id> --external-model <name> --embassy-agent <name> --mode dedicated|attached --display-name <text>` (with `--model-tier`, `--model-provider`, `--model-id` for dedicated mode)
    - `list` — table of registered conduits with mode, last-seen, retired-at
    - `retire <client-id>` — marks the conduit retired; the OAuth client + embassy Agent stay intact
  - **Embassy identity template** (spec section 3, verbatim shape): the Agent's role is the "<External> Embassy," explicit memory rules forbid pushing information outward, the conduit-status block carries connection metadata. Persona text loads as a normal system prompt.
- **OAuth Settings UI + runbook + grok.com defaults (Phase 2 / PR-A2).** Operator-facing polish on top of the PR-A1 substrate.
  - **`Settings → OAuth clients`**: Web Settings page gains a sub-section for registering / listing / revoking / rotating OAuth clients. Same two-step destructive confirms and copy-on-show secret-display discipline as `Settings → Work packages`. Register form defaults the redirect URI to the canonical grok.com callback discovered empirically 2026-05-23 (`https://grok.com/connectors-oauth-exchange-code/`); the result page prints the full block of values to paste at `grok.com/connectors → New Connector → Custom`.
  - **CLI default**: `2200 connector oauth-client register` now defaults `--redirect-uri` to the canonical grok.com callback. Override with the flag for other consumer-side MCP clients (Claude Desktop, ChatGPT MCP, etc.).
  - **`GROK_CONNECTOR_REDIRECT_URI` exported** from `src/runtime/mcp/connector/oauth/client-store.ts` so the CLI, daemon, and runbook stay in sync on the canonical value.
  - **`/.well-known/oauth-protected-resource`** (RFC 9728): protected-resource metadata published. grok-connectors-manager/0.1.0 probes this on every connect; cheap spec compliance.
  - **Daemon HTTP routes** (loopback): `GET /api/v1/connector/oauth-clients`, `POST /api/v1/connector/oauth-clients`, `POST /api/v1/connector/oauth-clients/:id/revoke`, `POST /api/v1/connector/oauth-clients/:id/rotate-secret`, `GET /api/v1/connector/grok-redirect-uri`. Same Supervisor methods the CLI verbs already hit.
  - **Operator runbook** at `wiki/grok-connector-setup.md` rewritten to reflect the empirical reality: choose-your-auth-path table, OAuth registration walkthrough, the static-bearer path documented separately. The Tesla / in-car section preserves "verify on your hardware" verbatim and explicitly notes it does not change until Doug personally watches it fire.
- **MCP connector OAuth 2.0 Authorization Server (Phase 2 / PR-A1).** Resolves the architectural gap discovered when Doug hit grok.com/connectors → New Connector → Custom: the consumer UI requires OAuth 2.0 + PKCE, not the static bearer Phase 1 shipped. The connector now serves both: the static bearer continues to work for developer-API callers (Claude Desktop, headless scripts), and a full OAuth AS now serves consumer-grade Grok / Tesla.
  - **OAuth endpoints** on the existing `:2201` connector listener: `GET /oauth/authorize` (code grant with mandatory PKCE S256), `POST /oauth/token` (code exchange + refresh-token rotation), `POST /oauth/revoke`, `GET /.well-known/oauth-authorization-server` (RFC 8414 metadata).
  - **Pre-authorize-at-registration consent model** (locked with Grok 2026-05-23): the operator registers each client at the trusted loopback surface via `2200 connector oauth-client register --display-name <...> --redirect-uri <...>`. Subsequent `/authorize` requests over the public tunnel proceed without operator presence, validated against the registered set. Zero operator-facing UI is exposed through the tunnel — preserving Phase 1's loopback-only operator-surface invariant absolutely. The pre-authorization step IS the human security boundary.
  - **Opaque tokens, sealed vault** (parallel to PR 1a's `bearer-store`): `2200-mcp-at-<43 base64url>` access tokens (24 h TTL default), `2200-mcp-rt-<43 base64url>` refresh tokens (90 d TTL default, with rotation_chain replay-detection per RFC 6749 BCP), in-memory authorization codes (60 s, one-time-use). Distinct HKDF namespaces; on-disk filenames are SHA-256 prefixes of the token (`ls` does not expose secrets).
  - **Refresh-token reuse detection.** Each refresh has a `chain_id` + `rotated` flag. Successful refresh marks the consumed token rotated. Reuse of a rotated token triggers `revokeChain(chain_id)` and emits `connector.oauth_refresh_reuse` (important tier) — the canonical compromise signal.
  - **Bearer ↔ OAuth coexistence on `/mcp`.** Token-prefix disambiguation: the listener's preHandler tries OAuth access-token verification first (when `Bearer 2200-mcp-at-...`), then falls through to the static-bearer constant-time-compare (Phase 1). Both auth paths live on the same endpoint; Phase 4's dispatcher hard-guard remains the real permission boundary regardless of which path authorized the request.
  - **Strict redirect-URI pre-registration** (no TOFU, no pattern matching). The operator pastes Grok's exact callback URL at registration time. `/authorize` rejects any unregistered redirect with `invalid_request` + a 400 response (no open-redirector hazard).
  - **PKCE S256 mandatory; `plain` rejected.** Client secrets are optional (PKCE-only is the recommended path matching grok.com's "Token Auth Method: none" default). When the operator opts in to a secret with `--mint-secret`, it's scrypt-derived-and-stored; the plaintext is shown once at registration time and never re-exposed (parallel to the static-bearer regenerate UX).
  - **CLI** (`2200 connector oauth-client register | list | rotate-secret | revoke`). The `register` output prints the exact block the operator pastes into grok.com/connectors → Custom (MCP server URL, Client ID, Authorization Endpoint, Token Endpoint, Scopes, Token Auth Method).
  - **Audit event family** `connector.oauth_*`: `client_registered` / `client_revoked` (lifecycle), `authorize_succeeded` / `authorize_rejected` (per-request), `token_issued` (initial grant + refresh rotation), `refresh_reuse` (important tier, fires on compromise).
- **Work-package approval Settings tile + operator runbook (PR 5).** Phase 1 wrap-up.
  - **Settings page tile** (`Settings → Work packages`) renders proposals handed in via `propose_work_package`. Filter by "Awaiting review" (default) or "All packages." Each package card shows summary + plan + risks + success criteria parsed from the body, with one-click Approve (two-step confirm) or Reject (optional reason). Approval routes the plan to the primary Agent via the existing task-submit substrate; rejection records the decision. Auto-refreshes every 15 s.
  - **Daemon HTTP routes** (loopback): `GET /api/v1/connector/work-packages` (with optional `?status=<...>` filter), `POST /api/v1/connector/work-packages/:id/approve`, `POST /api/v1/connector/work-packages/:id/reject` (`{ reason? }`).
  - **`listWorkPackages` library helper** in `runtime/mcp/connector/work-package.ts`. Sorted by createdAt descending, filtered by status, body included so the UI renders the parsed sections without a second round-trip.
  - **Post-regenerate copy-toast polish** on the MCP connector tile: after the operator clicks Copy on the freshly-minted token, the tile shows a short success-state pointing at the `grok.com/connectors` paste destination. Closes a minor PR 1b review note from Grok.
- **Operator runbook** at `wiki/grok-connector-setup.md`: tunnel options (ngrok quick-start, Cloudflare Tunnel, Tailscale Funnel), the grok.com/connectors registration walkthrough, in-car verify-on-your-hardware language verbatim from the locked Phase 1 handoff, security-posture summary, common knobs, troubleshooting.
- **MCP connector `propose_work_package` + dispatcher hard guard (PR 4).** Grok (or any other MCP connector caller) can hand a proposal of real work to the fleet — the safety-load-bearing piece of the connector substrate.
  - **New MCP tool** `propose_work_package`. Returns `{ status: 'queued_for_review', package_id, package_slug, coordination_task_id }`. The proposal lands as a normal Brain note at `<shared>/brain/work-package-<id>.md` (tagged `work-package`); the primary Agent gets a strict-allowlist coordination task that produces a reviewable plan.
  - **Hard guard in `ToolDispatcher`** (mechanical, not advisory). Two new task-frontmatter fields: `tool_policy: inherit_agent | strict_allowlist` (default `inherit_agent`, existing tasks unaffected) and `allowed_tools: string[]`. The dispatcher rejects off-list calls with `ToolDeniedError(name, 'task_allowlist_violation', ...)` BEFORE the existing identity-level check. Per-task cached lookup.
  - **Two restricted task kinds in Phase 1**: `work_package_coordination` (allowlist: `brain_read_shared`, `brain_search_shared`, `brain_list_shared`, `brain_write_shared`, `pub_post`, `pub_read`) and `standing_brief_synthesis` (PR 3 retrofit; allowlist: `brain_read_shared`, `brain_search_shared`, `brain_list_shared`, `brain_write_research_brief`). Inline "additions require explicit review" comments per the Grok lock 2026-05-23.
  - **Approval surface (CLI)**: `2200 connector work-package approve <package-id>` / `reject <package-id> --reason <...>`. Approval parses `## Plan` steps and submits normal Agent tasks via `cli.task.submit`.
  - **Five new Inbox events**: `connector.work_package_arrived` / `_plan_ready` (important), `_coordination_failed` / `_approved` / `_rejected` (normal).
  - **Supervisor outcome watcher**: lightweight 30 s poll observes terminal transitions of tracked coordination tasks.
- **Standing-brief synthesis layer for MCP connector research threads (PR 3).** Long Grok conversations now get high-quality re-engagement: each research thread maintained by a primary Agent who keeps a synthesized standing brief current as new contributions arrive.
  - **Sibling brief note** at `<shared>/brain/research-<slug>-brief.md` (separate from the chronological log shipped in PR 2). Full-rewrite each synthesis; tagged `standing-brief` + `research-thread`.
  - **Provenance** baked into brief frontmatter ... `synthesized_through`, `contribution_count`, `contribution_first_at` / `_last_at`, `contributor_sources`, `synthesizing_agent` ... computed by the write tool from the thread's chronological log, so machine-readable provenance is always present regardless of how the synthesized text cites its sources.
  - **Supervisor-side reconciler** (default 30 s poll, 60 s debounce) detects threads with `pending_synthesis_at > synthesized_through` + debounce elapsed + primary Agent running, and submits a synthesis task via the existing `cli.task.submit` substrate. The Agent's normal loop runs the LLM synthesis; cost stays on the Agent's budget where it belongs.
  - **New baseline tool** `brain_write_research_brief(thread_slug, brief_body, token_usage?, duration_ms?)` is the write surface the synthesizing Agent calls. Resets the thread's failure counter on success.
  - **New MCP tool** `get_research_brief(thread_slug)` exposes the full brief + provenance to the connector caller (Grok). `get_fleet_context` gains a per-thread `brief_excerpt` (first ~500 chars) + `brief_synthesized_through` + `brief_stale` + `brief_blocked` fields so the orientation packet stays small while signaling staleness.
  - **Failure handling**: three consecutive synthesis failures escalate to `synthesis_blocked: true` (tier-`important` Inbox event). Operator clears with `2200 connector synthesis unblock <thread-slug>`.
  - **Inbox events** (all under the `__connector` synthetic emitter): `connector.synthesis_started` (passive), `connector.synthesis_completed` (passive, includes duration + contribution count), `connector.synthesis_failed` (normal / important on block), `connector.synthesis_primary_missing` (normal).
  - **Global synthesis budget guard** (stretch from the locked design): optional fleet-wide cap on connector synthesis spend over a rolling window, off by default.
- **MCP connector real Phase 1 tools (PR 2).** Two structured tools land on top of the substrate plus the existing `liveness` probe:
  - `contribute_to_thread`: Grok (or any MCP client) hands a structured contribution (`research_findings`, `reasoning`, `sources`, `open_questions`, `proposed_direction`, optional `related_threads`) into one of two destinations via a discriminated `target` union. `{ thread: <name> }` appends a `## <ISO ts>` section to a shared-brain research thread anchor at `<shared>/brain/research-<slug>.md` (created on first contribution, tagged `research-thread`). `{ agent: <name> }` writes the contribution as a standalone Brain note at `<agent>/brain/grok-contribution-<compact-ts>-<hash>.md` (tagged `grok-contribution`). Both paths are normal Brain notes that participate in the existing `brain_search` / `brain_read` surface ... no special-casing in the brain layer. Phase 1 contributions are inert from an execution standpoint (read material only).
  - `get_fleet_context`: small, structured orientation packet (`agents`, `threads`, `recent_activity`) so a returning Grok conversation can pick up cleanly after a long gap. Deliberately small ... PR 3's standing-brief layer is what makes re-engagement high-quality.
- **`connector.contribution_received` Inbox event** (passive) carrying `target_kind` (`thread` | `agent`), `target_name`, `contribution_slug`, `contribution_path` so the Inbox row links straight to the produced note.
- **`bodyLimitBytes` operator escape hatch** for the connector listener. Default raised from 1 MiB to 8 MiB (sized for `contribute_to_thread` research blobs); overridable via `TWENTYTWOHUNDRED_CONNECTOR_BODY_LIMIT_BYTES` env var. Trade-off documented in the as-shipped decision record: larger body = larger public-facing DoS surface.

### Changed

- **MCP connector Phase 1 substrate polish (PR 1d).** Tidy-up pass after Grok's full byte-level review. Documentation strengthened (X-Forwarded-For tunnel-trust assumption inline in `clientIp`; bodyLimit comment flagging the PR 2 need to widen when `contribute_to_thread` lands with large research payloads; per-fleet-salt WHY in `bearer-store.ts`; first-run wording aligned with the Grok-First step). Sync `getConnectorStatus` renamed to `getConnectorStatusFast` with a strong "not for operator surfaces" guard comment ... the async `getConnectorStatusDetailed` remains the only surface used by CLI / web / RPC. `2200 connector token show` now writes paste guidance to stderr (stdout stays clean for `... | pbcopy`). First-run success message uses the same "sealed to disk" voice as the Grok sign-in step. New regression test for the idle → regenerate listener transition. Decision record at [[2026-05-23-mcp-connector-phase1-as-shipped]] pins the substrate-level decisions before Phase 2 begins.

### Added

- **First-run wizard offers MCP connector setup (PR 1c).** After Grok sign-in in the bare-`2200` wizard, the operator is offered a one-question opt-in to mint a connector token inline. Default NO ... keeps the install path uncluttered for users who do not know what MCP is. On yes, the wizard mints the bearer through the daemon's `cli.connector.regenerate` RPC and surfaces the token once with paste-target instructions (`grok.com/connectors` → New Connector → Custom). Failure is non-fatal; the operator can retry via `2200 connector token regenerate` or the Settings tile.
- **MCP connector Settings tile + daemon routes (PR 1b).** Operator UI for the MCP connector lives in Settings: status line + masked token + reveal + copy + 2-step regenerate / disable. New daemon routes on the loopback web UI listener (`GET /api/v1/connector/status`, `GET /api/v1/connector/token`, `POST /api/v1/connector/regenerate`, `POST /api/v1/connector/disable`). After regenerate the freshly minted token is shown once in a copy-to-clipboard banner with the paste target (`grok.com/connectors` Authorization). Inline two-step destructive confirms (no `window.confirm`).
- **Web-UI loopback safety check.** At supervisor start, if `TWENTYTWOHUNDRED_WEB_HOST` is overridden to a non-loopback host the daemon emits a `normal`-tier Inbox event (`connector.web_host_non_loopback`) explaining the foot-gun and how to revert. The MCP-connector security model assumes the web UI is loopback-only.
- **MCP connector substrate (Phase 1 / PR 1a).** 2200 now exposes itself as a remote MCP server, on a dedicated Fastify listener (default `:2201`, configurable via `TWENTYTWOHUNDRED_CONNECTOR_PORT`) isolated from the web UI listener. Bearer-token auth via the sealed vault (constant-time compare, no fallback-allow, 32-byte `2200-mcp-<base64url>` tokens). Every inbound call surfaces as an Inbox event; failed-auth events are throttled per source IP to one per 10 minutes. PR 1a ships the substrate plus a single `liveness` probe tool; the real Phase 1 tool surface (`contribute_to_thread`, `propose_work_package`, `get_fleet_context`) lands in subsequent PRs after Grok's code review on this layer.
  - New `2200 connector` CLI: `token show | regenerate | disable`, plus `status`. `regenerate` and `disable` route through the daemon over UDS so the live listener's cached bearer is swapped atomically.
  - Sealed bearer store at `<home>/state/connector/bearer.json` (AES-256-GCM + HKDF, distinct namespace from the OAuth token store).
  - Inbox audit events: `connector.call_received`, `connector.auth_rejected`, `connector.listener_state_changed`.
  - Architecture review by Grok on listener boundary + auth model before PR; design note at `wiki/inbox/grok/2026-05-22-mcp-listener-auth-design.md`.
- **Grok-First: SuperGrok / X Premium+ subscription auth (no API key).** Sign in to your existing xAI Grok subscription and every Agent set to the new `xai-subscription` provider uses the subscription bearer ... no `XAI_API_KEY` needed. The API-key path remains as a separate, parallel provider (`xai`).
  - Settings page: prominent "Sign in with X / SuperGrok" tile at the top, with the official Grok logo. Inline device-code flow with a phone-friendly URL + code; auto-polling status until completion. (`#237`)
  - Model picker: new "Subscriptions" optgroup pinned at the top of the dropdown. `xAI / Grok (SuperGrok subscription)` is a selectable provider distinct from the API-key sibling, so the credential choice is visible in the Agent's Identity. (`#238`, `#239`)
  - Auto-restart on model switch: changing an Agent's model from the picker now stops + restarts the Agent so the new credential / provider binding is what serves the next request. Inline spinner during the swap; clear error surface if restart fails. (`#240`)
  - First-run installer: the bare-`2200` wizard now offers Grok subscription sign-in inline (default yes) after user-identity mint, so a new install can leave setup with a working Grok credential without ever pasting an API key. (`#237`)
  - CLI: `2200 oauth xai login | status | logout` for headless / scripted setup. Device-code flow with PKCE S256, public-client OAuth. (`#236`)
- **Generic device-code OAuth substrate** (`src/runtime/oauth/device-flow.ts`). RFC 8628 with PKCE S256; reusable for any future public-client provider. Handles `authorization_pending`, RFC-spec `slow_down`, `expired_token`, `access_denied`. (`#236`)
- **Fleet-scoped sealed OAuth token store** at `<home>/state/oauth-tokens/`. AES-256-GCM + HKDF over the per-instance master key with a fleet-scoped HKDF info string. Separate namespace from the per-Agent credential vault. (`#236`)
- **Background OAuth refresh service.** `TokenRefreshService.tick()` now also scans the fleet OAuth store and refreshes within 120s of expiry using `grant_type=refresh_token`. Same failure-cooldown logic as the existing per-Agent path. (`#236`)
- **Daemon HTTP endpoints**: `POST /api/v1/oauth/xai/login/start`, `GET /api/v1/oauth/xai/login/status?session=<id>`, `GET /api/v1/oauth/xai/status`, `POST /api/v1/oauth/xai/logout`. Browser-driven device-code flow without leaking PKCE state across requests. (`#237`)
- **`install.sh` auto-configures `~/.npm-global` on non-writable npm prefix.** Detects the typical Ubuntu/Debian footgun (system `npm` at `/usr` requires sudo), explains the situation in plain language, and auto-fixes it without admin access. Shell-aware (bash / zsh / fish). Idempotent on re-runs. (`#233`)

### Changed

- **Chaos test stability**: eliminated the `supervisor-bounce-survival` flake by waiting for the heartbeat loop to cycle before bouncing the supervisor in-test. Root-cause fix, not a retry config. (`#234`)
- **Adopted `@eslint/js` v10**: bumped from 9.39.4 and adopted the two new rules `preserve-caught-error` and `no-useless-assignment`. 26 violations fixed across the codebase ... most now add `{ cause: err }` chains to thrown errors inside `catch` blocks, so debug sessions see both the symptom and the underlying error. (`#235`)
- **Lock-based PID liveness** for the supervisor and every Agent. Replaced the historical `kill(pid, 0)` liveness check with `proper-lockfile` lock holdership. Eliminates the stranger-PID hazard (recycled OS PIDs falsely reporting our processes as alive). Migration is operator-walkable: a daemon from a pre-lock release is detected and reported with a clear recovery message. (`#230`)

## [0.1.0] ... 2026-05-20

### Added

- **First installable build.** The first version that could be installed end to end; never actually published to a registry (see the calendar-versioning note at the top of this file). The published package is `@twentytwohundred/2200-cli` from `2026.612.1935` onward.
- **Shell installer** at `install.sh`. One-liner for any macOS or Linux box with Node 22+: `curl -fsSL https://2200.ai/install.sh | sh`. The 2200.ai URL is an nginx reverse-proxy to the script in this repo, so the install script remains a single source of truth in the repo. Detects Node version, refuses to silently elevate via sudo, and installs the latest published version via the user's `npm`.
- **Bare `2200` first-run.** When the CLI is invoked with no subcommand and no prior install state, it walks the user through a guided setup: choose `2200_HOME`, initialize the directory layout, start the supervisor daemon, mint the user identity, point at `2200 agent build` for the first Agent. All input is collected before any side effect, so a `ctrl-C` at any prompt is safe.
- **`2200 update`.** Top-level self-upgrade. Checks the npm registry for the latest published version, prompts (or `--yes`), stops the daemon, installs the new package globally, restarts the daemon. `--check` reports availability without installing. Refuses to auto-upgrade a source checkout.
- **`2200 --version`** now reads from `package.json` at runtime, so `npm version <bump>` is the single source of truth for the installed CLI version.
- **Web upgrade button.** Settings → System tile shows current vs. latest version. Click → 2-step inline confirm → the daemon writes `<home>/state/upgrade-status.json`, spawns a detached helper, and shuts itself down. The helper waits for the daemon to exit, runs `npm install -g`, and starts the new daemon. The web UI polls the status throughout, absorbing the brief mid-upgrade outage, and surfaces the per-stage progress.
- **System HTTP endpoints**: `GET /api/v1/system/version`, `POST /api/v1/system/update`, `GET /api/v1/system/upgrade-status`.

### Notes

- 2200_HOME state (under `~/.local/share/2200/` by default, or whatever you chose at first-run) is never touched by `2200 update`. Upgrades only replace the global package binary.
- Native dependencies (`better-sqlite3`, `sharp`) ship prebuilds for macOS arm64/x86_64 and Linux arm64/x86_64. Other platforms fall through to a build-from-source path that requires a C++ toolchain.
- Windows is not supported on this release. Use WSL2.

### Added (prior to 0.1.0)

- Repository scaffolding: LICENSE, README, AGENTS.md, SECURITY.md, CONTRIBUTING.md, CHANGELOG.md, THIRD_PARTY_NOTICES.md, `.github/` templates and CI workflow.
- Public wiki at [`twentytwohundred/wiki`](https://github.com/twentytwohundred/wiki), mirrored from the canonical Brain-format tree.
- Spec scaffolding (in the wiki): vision, architecture, epic map, seed team, 48 decision records, 11 conventions, per-epic specs, design system + design docs, prior-art analysis with deep findings appendix.
- **Epic 2: Agent runtime minimum.** Shipped. Supervisor, Identity loader, Brain (filesystem-first per [decision record](https://github.com/twentytwohundred/wiki/blob/main/decisions/2026-04-24-brain-is-files-not-database.md)), baseline tool set, plan/run/perm wrapping on every tool call, integer schema versioning everywhere, control-plane protocol over UDS+JSON-RPC.
- **Epic 3: Local pub integration via OpenPub.** Shipped. Pub supervision substrate, user and Agent pub identities, four pub MCP tools, WebSocket wake source, end-to-end smoke test against `@openpub-ai/pub-server@0.3.3`.
- **Epic 3.5: Two-agent demo.** Shipped. Hobby↔Simon coordination on the seed-team box, with the published runbook reproducible end-to-end.
- **Epic 3.6: Multi-provider and ambient routing.** Shipped. Six LLM providers wired (Anthropic native; OpenAI, DeepSeek, Kimi, OpenRouter, Gemini via the OpenAI-compatible adapter and `OPENAI_COMPATIBLE_VENDORS` table). Pub message router service with per-pub roster sidecars, opt-in via `ROUTER_PROVIDER` and `ROUTER_MODEL_ID`.
- **Epic 3.7: Followup model and chat polish.** Shipped. `Identity.model.followup_model_id` for two-tier model selection per Agent. Chat status notices.
- **Epic 3.8: Multi-Agent ack-spiral fix.** Shipped. Structural guards in the wake source: skip the router when sender is a known Agent; respect explicit `@`-mentions; per-pub roster self-upsert on Agent start; complete-roster perspective in router input.
- Local `pnpm patch` for `@openpub-ai/pub-server@0.3.3` (keepalive listener and bartender-guard fixes), to be dropped when v0.3.4 ships upstream. See [openpub-ai/openpub#1](https://github.com/openpub-ai/openpub/issues/1).

### Notes

- No tagged releases yet. Versioning begins when the runtime is feature-complete enough for the first public preview.
- The `wiki/` feature on this repo is disabled; the project knowledge base lives at [twentytwohundred/wiki](https://github.com/twentytwohundred/wiki) (public, markdown on `main`).

[Unreleased]: https://github.com/twentytwohundred/2200/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/twentytwohundred/2200/releases/tag/v0.1.0
