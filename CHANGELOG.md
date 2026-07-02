# Changelog

All notable changes to 2200 are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions follow calendar versioning: `YYYY.M.D` (the UTC date of the cut, no leading zeros, at most one release per day), so an operator can read at a glance how far behind they are. Versions before 2026.6.12 followed semver; `0.1.0` below was never published.

## [Unreleased]

## [2026.702.2310] ... 2026-07-02

### Security

- **The live-updates WebSocket now checks the request `Origin` server-side.** With the session moved to a cookie (previous release), a page at another website could try to open a socket to your instance and rely on the browser attaching your cookie (cross-site WebSocket hijacking). `SameSite=Lax` should already prevent that, but 2200 doesn't lean on "should": the WebSocket upgrade is rejected outright (`4403`, before authentication) when the `Origin` doesn't match the instance's own host. A non-browser client (which has no ambient cookie to hijack) is unaffected and still needs a valid credential.

## [2026.702.2247] ... 2026-07-02

### Security

- **Web sign-in now uses an HttpOnly session cookie ... your access token is no longer readable by page scripts or exposed in any URL.** Previously the token lived in the browser's `localStorage` (any script on the page could read it) and rode in `?token=` query strings for the live-updates socket and avatar images (so it could land in history and logs). Now you paste the token once into the sign-in form; the server exchanges it for a secure, browser-only cookie (`HttpOnly`, `SameSite=Lax`, `Secure` over HTTPS) that the browser attaches automatically to every request, including the WebSocket and images. The token is never held in JavaScript and never appears in a URL. Non-browser API clients still use `Authorization: Bearer`. New `POST /api/v1/auth/login` (rate-limited on the same lockout) and `/auth/logout`.
- **Secure by default: a fresh install binds to loopback (`127.0.0.1`), not all interfaces.** Nothing is reachable ... not even from your own LAN ... until you deliberately choose how to expose it (LAN, Tailscale, or the Cloudflare tunnel). Previously a new install was LAN-reachable out of the box.

## [2026.702.2218] ... 2026-07-02

### Security

- **Box-level login lockout, independent of Cloudflare.** After 10 failed authentication attempts from one client within 5 minutes, that client is locked out for 15 minutes (HTTP `429` + `Retry-After`), checked before the token is even compared. Keyed per client ... behind the tunnel the real client is read from Cloudflare's `CF-Connecting-IP` (which Cloudflare sets and a client can't forge through the tunnel), otherwise the socket address ... so no one can lock anyone else out. A successful login clears the count. This is defense-in-depth on top of the 256-bit bearer: brute force was already infeasible, but repeated guessing now gets shut off and stops filling the logs.

## [2026.702.2115] ... 2026-07-02

### Internal

- **Groundwork for the self-serve Cloudflare Tunnel (Epic 19).** No user-facing behavior yet ... internal modules the access-mode picker and `cloudflared` sidecar will assemble from: the tunnel-broker provision/revoke client (byte-compatible request signing), a sealed instance-secret store for the broker secret + tunnel token (same AES-256-GCM sealing as the OAuth tokens), and the access-mode config (cloud / local / tailscale) with the loopback-vs-LAN bind decision. Domain-agnostic ... the tunnel hostname comes from the broker, so the chosen domain drops in with no code change.

## [2026.702.32] ... 2026-07-02

### Added

- **Rename your Agent in the onboarding preview before it's built.** The preview showed the interview-derived name read-only, so "Let's call it Mira" shipped as `lets-call-it-mira` with no way to fix it. The preview now has an editable name field, and whatever you type is tidied into a valid identifier ("Mira The Great!" becomes `mira-the-great`, "2200" becomes `agent-2200`); a name with no usable letters is rejected with a clear message, and a collision with an existing Agent is caught before anything is written.

### Fixed

- **Onboarding survives a reload or navigating away instead of losing the whole interview.** A page reload or an in-tab navigation mid-interview used to silently discard the session ... "answered five questions, misclicked, start over." The session now persists to the browser so a reload or a trip to another screen and back **resumes** where you left off, prior answers intact. An expired session quietly starts fresh.

## [2026.701.2304] ... 2026-07-01

### Security

- **Transport-edge hardening.** Three pre-public fixes; none change a normal user flow:
  - The two gateway-internal HTTP routes (connector inbound, Extension pair-state) skipped bearer auth on the rationale that only a same-host child calls them. With the web server bound to all interfaces they were reachable across the LAN, so any host on the network could forge connector events (which turn into Agent tasks) or pairing state. They now require a loopback source ... the gateway child posts to `127.0.0.1`, so the real flow is unchanged; an off-box request gets a `403`.
  - A bearer token in a URL leaks (browser history, referrers, proxy/access logs). The `?token=` query form ... a header fallback for surfaces that can't set one ... is now accepted ONLY on the WebSocket upgrade and the avatar-image GET (loaded via `<img>`). Every other route requires the `Authorization` header.
  - The connector's OAuth Authorization-Server metadata derived its issuer URL from each request's `Host` header into shared state ... host-header-injectable (advertise a rogue token endpoint a discovering client would post its code + secret to) and racy across concurrent requests. It now pins to an operator-configured public URL when set, and otherwise derives per-request with a loopback default.

### Fixed

- **The System Update tile no longer stalls (and shows a stale "Upgrade" button) mid-upgrade.** When the daemon briefly restarts as part of an upgrade, the status poller used to give up permanently ... the progress stepper vanished and the old "Upgrade to X" button reappeared even though the upgrade was still running. A "mid-upgrade" latch now keeps the tile polling through that restart window and only stops once the upgrade actually finishes.

## [2026.701.2123] ... 2026-07-01

### Changed

- **Pre-public polish on the surfaces a demo audience actually sees.** Four camera-visible cleanups, no behavior-critical paths touched:
  - The internal component-library reference page is no longer reachable on a real instance ... it was listed in the ⌘K command palette and its route was live in production. The palette entry is gone and the `/dev/components` route is now dev-build-only.
  - Settings no longer renders off-palette reds and greens. Six style modules referenced color tokens that didn't exist (`--ds-danger`, `--ds-error`, `--ds-warning`, `--ds-success`) and fell back to hardcoded hex, so those chips never tracked the dark theme. They now use the real `--danger` / `--warn` tokens, and a `--success` / `--success-soft` pair was added to fill the one genuine gap (the design system had danger / warn / info but no positive-state color).
  - Deleting a schedule now takes two clicks (arm, then confirm ... auto-disarming), matching every other destructive action instead of firing on a single click.

### Fixed

- **A clear message instead of a raw crash when 2200 is installed on an old Node.** Installing via `npm i -g` on Node older than 22 used to dump an opaque `ERR_DLOPEN_FAILED` from the native `better-sqlite3` addon the instant the CLI started. The CLI now checks the Node version before that addon loads and exits with a plain-language "upgrade Node to 22+" message. (The `install.sh` path already preflighted this; the bare npm path didn't.)

## [2026.701.2102] ... 2026-07-01

### Fixed

- **The five stranger-path onboarding dead-ends are closed.** A pre-public QA sweep found five deterministic ways a first-time user (or a demo audience) could get stuck on the path from `npm install` to chatting with a freshly-spawned Agent in the Studio. All five are fixed:
  - **A fresh install never got a Studio.** The shared `studio` pub was created only at daemon boot, which no-ops on a fresh install (zero Agents on disk). The first Agent ... spawned later through onboarding ... had no room to appear in, and its seeded orientation post to `studio` failed too. The Studio is now ensured when that first Agent is built (inside `migrateFromHandoff`, the single chokepoint shared by the web-confirm, CLI-spawn, and CLI-migrate paths), before the Agent starts, so it attaches the studio wake source on first launch. It only looked fine before on boxes that already had Agents from a prior boot.
  - **A dead provider during the interview silently produced a garbage Agent.** The interview deliberately swallows provider errors (so a transient hiccup never 500s), but that turned a persistently-unreachable provider into a half-built Agent bound to a model that can never chat ... with no error shown. Picking the `local` provider with the endpoint down (Ollama not running, the exact cold-start fallback first-run offers) now fails fast at onboarding start with an actionable message naming the endpoint, via a cheap `/v1/models` reachability probe.
  - **API keys pasted in the setup wizard were dead until a restart the wizard never did.** The daemon starts early in setup; keys entered afterward went to `runtime.env`, but a supervisor reads that file only at boot, so the operator's very first onboarding attempt died with `env var 'ANTHROPIC_API_KEY' is not set`. The wizard now restarts the daemon when it wrote any keys, so they're live before setup finishes.
  - **The main chat screen ate failed sends and could spin "Thinking…" forever.** A send that failed (Agent stopped, network blip) vanished silently because the composer clears on submit; it now surfaces an inline error with a Retry that re-sends the exact message. And the "thinking" placeholder no longer spins indefinitely when an Agent dies mid-reply ... it gives up on the Agent's error state or a tool-activity-aware backstop (a late reply still lands as a normal message).
  - **Odd or duplicate Agent names 500'd and wedged the interview.** A name that didn't reduce to a valid identifier ("2200", non-Latin scripts, emoji) threw during the build, surfaced as a generic 500, and left the session permanently stuck (every retry re-threw). Names now derive gracefully ("2200" → `agent-2200`) and never throw; a name collision returns an actionable 409 before any files are written instead of a 500.

## [2026.625.1807] ... 2026-06-25

### Added

- **A "Restart all Agents & services" button in Settings → System.** When an Agent gets wedged (e.g. stuck `blocked_on_agent` and no longer responding), there was no in-app way to recover it ... you had to drop to the CLI. The new button bounces every pub-server, Agent, and connector gateway in one click, WITHOUT restarting the daemon itself (it stays up to serve the request and orchestrate the restart, so the web app never goes dark). Pubs restart first so Agents reconnect to fresh pub-servers; then each Agent is restarted (the actual unstick); then connector gateways are refreshed. Two-step inline confirm (no browser popup), and the result reports exactly how many Agents and services came back (and names any that didn't). Backed by `POST /api/v1/system/restart` → `Supervisor.restartFleet()`, best-effort and independent per target. Your fleet state on disk is untouched.

## [2026.624.1204] ... 2026-06-24

### Fixed

- **Agents no longer go silent ~6h after they start.** An Agent bound to the `xai-subscription` (SuperGrok) provider captured the OAuth bearer once, at spawn. The fleet bearer is ~6h-lived and the background refresh rotates it ... but a running Agent never picked up the new one, so once its cached copy expired, **every** LLM call returned `403 auth failed`: the ambient router (so nobody chimes in on an untagged message, and the member dots stay grey/idle) AND the main loop (so even an @-mention couldn't actually reply). Only a restart fixed it, until the next rotation. The pub-server already re-read the rotated token; Agents now do too ... the `xai-subscription` provider reads the bearer **fresh from the sealed token store on every request** (one small decrypt, no network), so a rotated fleet token is used immediately with no restart and no 6-hourly Agent flapping. (The same fix covers the per-Agent ambient router, which shares the provider.) Other providers are unchanged ... static API keys are still captured once.

## [2026.623.1738] ... 2026-06-23

### Changed

- **From-tarball install smoke + isolated chaos tests (QA hardening, no runtime change).** Two gaps an independent QA pass flagged:
  - **`scripts/smoke-install.sh` (`pnpm smoke`)** packs the tarball, installs it in a clean `node:22` container, and asserts the regression classes that have actually bitten on real installs: `setup` serves the web app keyless, the **pub-server patch overlay applies**, the Studio auto-provisions and **dedupes** (one row per Agent, no `(agent)` shadow), the pub-server runs with **no LLM credential** (Bartender off), the pub survives a daemon restart **without a port collision**, and **Studio chat persists across a restart**. Wired into CI as a gate on PRs to `main` (`.github/workflows/smoke.yml`). This is the end-to-end guard the unit tests couldn't give.
  - **Chaos tests now run isolated** (`vitest.chaos.config.ts`, single fork, file-parallelism off) instead of competing with ~190 other files for CPU ... the prior timeout loosening was a band-aid; running `supervisor-bounce-survival` with dedicated CPU is the real fix for its flake. `pnpm test` runs the main suite then the isolated chaos pass.
  - Documented the pub adoption/orphan/overlay story in one place (`pub-port.ts`) so the interlocking pieces aren't re-broken, and prettier now ignores the in-repo `.pnpm-store/`.

## [2026.623.1702] ... 2026-06-23

### Fixed

- **`2200 update` over SSH no longer leaves the daemon down.** The update stops the daemon, runs `npm install -g`, then restarts it via the freshly-installed binary's `daemon start`. That restart was spawned with inherited stdio and `await`ed, which tied the new daemon's startup to the `2200 update` process ... and over SSH that parent exits the instant the command returns, taking the half-started restart chain down with it (observed live on valkyrie: a remote `2200 update` installed the new version but the daemon never came back). The restart is now spawned **fully detached** ... its own session (`detached: true` => `setsid` on POSIX), no inherited stdio, `unref`'d ... so it survives a parent that dies the moment the command returns. Liveness is confirmed by **polling the supervisor lock** rather than awaiting the (now-detached) child, so the up/down signal also doesn't depend on the parent surviving; if the parent is killed mid-poll, the daemon is still coming up underneath. (Local interactive `2200 update` was already fine; this fixes remote/headless updates.)

## [2026.623.1638] ... 2026-06-23

### Fixed

- **The Studio no longer breaks (HTTP 409 on send) after a `2200 update`.** A pub-server can outlive the supervisor that spawned it ... an update restart, a SIGHUP self-upgrade, or a detached crash leaves it running and still holding its TCP port. On the next boot the fresh supervisor launched a _new_ pub-server on that same recorded port, which died instantly on `EADDRINUSE`; the pub record flipped to `errored`, and the supervisor's pub-bridge then reported `pub_not_running` ... so posting to the Studio returned HTTP 409, even though a perfectly healthy pub-server was sitting right there on the port. (Hit live on valkyrie right after updating to 2026.623.1612: a pub-server from days earlier held the port and every relaunch collided.) `startPub` now inspects the port before launching: if a healthy pub-server is already serving it, **adopt** it (no relaunch, no collision, no flap of the Agents' WebSockets); if a wedged listener is stuck there, reclaim it and launch fresh; otherwise just launch. The decision is a pure, unit-tested `planPubPort`. So an update (or any restart) brings the room back instead of stranding it.

## [2026.623.1612] ... 2026-06-23

### Fixed

- **The `supervisor-bounce-survival` chaos test no longer flakes under parallel CI load (test-only).** The test SIGKILLs the supervisor, restarts it, and waits for the agent to reconnect and advance its heartbeat. That reconnect wait was capped at 25s, which held in isolation but timed out when the full suite saturated the CPU with ~16 workers ... a false red that cost a re-run. Bumped the reconnect wait to 60s and the overall test budget to 150s so a slow-under-load run still passes (and a genuine hang fails with the test's own clear message, not a vitest timeout). No product code changed.

## [2026.623.1350] ... 2026-06-23

### Changed

- **The pub-server patch-overlay decision is now unit-tested (no behavior change).** The logic that overlays 2200's patched `server.js` onto an npm-installed pub-server (keepalive + Bartender-off) probes several candidate paths for both the installed file and the shipped patch ... and getting the shipped-patch depth wrong is the bug that shipped twice (`2026.617.327` then `.342`) before the overlay actually applied. The path-probing + marker decision is extracted into a pure, injectable `planPubServerPatch` with a dedicated test (finds the patch at a deeper bundle depth, idempotent when already patched, never overwrites with an unpatched copy, warns when no shipped patch is found). `ensurePubServerPatched` is now the thin I/O executor over that decision. This is the regression guard for the "Agents silently dropped from the Studio after ~60s" class of failure.

## [2026.622.2027] ... 2026-06-22

### Fixed

- **A SuperGrok-only install can start onboarding ... the default provider pick now counts the subscription.** When `POST /api/v1/onboarding` is called without an explicit provider (the CLI/legacy path), it auto-picks a provider from the catalog. That pick only looked at runtime.env API keys, so it never saw the `xai-subscription` credential (which lives in the sealed fleet OAuth store, not runtime.env) ... a "Sign in with X / SuperGrok" install with no API key fell through to the keyless `local` fallback (Ollama at `localhost:11434`, usually not running), and the interview failed to connect. The pick now treats an active subscription as a real credential and prefers it over the keyless fallback, matching the web picker. (The web onboarding flow always passed the provider explicitly, so it was already fine; this fixes the no-explicit-provider path.) Pulled into a pure, unit-tested `pickOnboardingProvider` helper. So: one SuperGrok sign-in is all an operator needs ... no second model, no API key.

## [2026.618.1542] ... 2026-06-18

### Fixed

- **A self-hosted Ollama model now binds ... the Identity `model_id` accepts an Ollama-style `:tag`.** Ollama names its models `name:tag` (`gemma4:26b`, `llama3.1:8b`), and the API 404s on a bare name when no matching `:latest` exists ... so the exact tagged id is required. But the Identity schema's `model_id` rule (`/^[a-z0-9.-]+$/`) forbade the colon, so a `local`-provider Agent could not be bound to any tagged Ollama model: the daemon rejected the Identity at load with `model.model_id must be lowercase alphanumeric, dashes, or dots` and the Agent crash-looped. (The `provider` field already allowed an optional `:tag`; only `model_id` didn't ... an oversight.) `model_id` now accepts an optional `:tag` suffix, with the tag permitting mixed case + underscores so Ollama quantization tags work too (`llama3.1:8b-instruct-q4_K_M`). `grok-4.3`, `gemini-2.5-pro`, and other colon-free ids are unaffected.

## [2026.617.1412] ... 2026-06-17

### Fixed

- **The "web UI is bound to a non-loopback address" notice no longer re-fires on every restart.** `quick-setup` deliberately binds the web UI to `0.0.0.0` so the LAN/Tailscale URL is reachable, which tripped the connector security heads-up on every daemon boot and filled the inbox with duplicate notifications about the intended default. It is now a one-time notice per bind: you see it once, it stays quiet across restarts, and it speaks up again only if you change the bind to a different non-loopback `host:port` (or revert to loopback and later re-widen).

## [2026.617.1255] ... 2026-06-17

### Added

- **The Studio keeps its history ... you never come back to a blank screen.** The OpenPub pub-server keeps only an in-memory conversation window and explicitly delegates persistence to the on-box host, so that window was lost on every restart. 2200 now persists each pub's chat to a durable per-pub log (`state/openpub/<pub>/messages.jsonl`) and the messages endpoint serves the merge of that log with the live window, deduped by id. So the chat is there on entry, across restarts and fresh sessions. Append-only on the hot path; trimmed to the last 2000 messages.

### Changed

- **Tighter message spacing in the Studio.** The gap between messages was 28px (a lot of empty space); it's now 12px.

### Fixed

- **Ambient responses work again ... post an untagged question and someone answers.** Every Agent in a room runs its own router LLM call to decide "should I chime in," so one untagged message fired N simultaneous grok calls and the SuperGrok subscription's concurrency limit 403'd them (`auth failed`) ... which the router treated as "nobody responds" (and cached that no-op). The router now staggers each Agent's call with jitter, retries transient failures (the 403, rate limits, 5xx, network) with backoff, and never caches a transient failure (so the missed-mention sweep can still re-route). So a rate-limited router recovers instead of giving you blank stares.

### Added

- **`@all` (and `@everyone`) reach everyone in the room.** Extends the existing `@team` broadcast: any message containing `@all` / `@everyone` / `@team` wakes every Agent present, deterministically (no router involved), so it always lands. Word-boundary guarded (`@allow`, `@everyone-else` don't trigger).

## [2026.617.342] ... 2026-06-17

### Fixed

- **The pub-server patch overlay now actually finds its shipped copy.** 2026.617.327 shipped the patched `server.js` and the overlay logic, but the path it probed for the shipped file (`dist/vendor/...`) was wrong for the daemon's bundled entry (`dist/runtime/supervisor/bootstrap.js`), so the overlay logged "no shipped patch found" and the pub-server stayed unpatched (agents still dropped at ~60s). Probe each entry depth and take the first that exists. (The Bartender-off half of 327 was already working.)

## [2026.617.327] ... 2026-06-17

### Fixed

- **Agents stay in the Studio and answer ... the pub-server patch now reaches every install, and the Bartender is gone.** Two halves of the same root cause. (1) **The keepalive fix now ships.** OpenPub's agent-connection handler never resets a socket's liveness on `pong`, so its ping cycle terminates each Agent ~60s after it joins ... dropping skippy/jodin from the room before they could answer. 2200 patches this, but the patch was applied only via pnpm `patchedDependencies`, which `npm install` ignores ... so every real install ran the unpatched, agent-killing pub-server. The patched `server.js` is now shipped in `dist` and overlaid onto the installed pub-server at launch (idempotently; a no-op in the dev repo where pnpm already patched it). (2) **The Bartender stays off.** The same patch makes OpenPub's Bartender persona + memory-fragment generation clean no-ops when no `LLM_API_KEY` is set ... and 2200 deliberately never gives the pub-server an LLM credential. The Studio is the operator and their Agents, nobody else. (This reverts the 2026.617.256 attempt to run the Bartender on the subscription ... that was the wrong direction; the Bartender shouldn't be in the Studio at all.)

## [2026.617.256] ... 2026-06-17

### Fixed

- **Agents stay in the Studio and respond ... the pub-server now runs on the fleet subscription.** The OpenPub pub-server has its own LLM for the Bartender persona + conversation-memory fragments, configured via `LLM_PROVIDER`/`LLM_BASE_URL`/`LLM_API_KEY`/`LLM_MODEL` env. 2200 was setting **none** of them, so those calls 401'd ... and the failed memory-fragment broadcasts destabilized agents' WebSocket connections, kicking skippy/jodin out of the room ~60s after they joined (so they never saw a message to answer). 2200 now resolves the operator's active subscription and injects those vars, so the pub-server's calls succeed and the agents stay put. The agents themselves were already correctly on the subscription; this fixes the pub-server that was knocking them offline. New `src/runtime/config/fleet-defaults.ts` is the single source of truth (credential from the sealed OAuth token store, base URL from the provider registry, model id from the catalog ... no model literal at the call site). When no subscription is signed in, the LLM vars are omitted and the pub-server's patched guards turn the bartender + fragments into clean no-ops.
- **The pub-server's subscription credential is kept fresh.** The OAuth bearer is short-lived (~6h) and a long-running pub-server holds the value it got at spawn. When the background refresh rotates the fleet token, the supervisor now restarts running pubs so they pick up the new bearer instead of 401-ing again hours later.

### Added

- **`grok-4.3` is in the model catalog** (xAI frontier), so the fleet-default resolver reads it from the one allowed model registry rather than any call site inlining a model string. (First step of the broader "no hardcoded model anywhere" sweep; migration/onboarding/audit defaults follow in a separate change.)

## [2026.617.121] ... 2026-06-17

### Fixed

- **`2200 update` now reliably brings the daemon back up ... it no longer leaves you with a stopped daemon and a non-responsive web.** `2200 update` stops the daemon, runs `npm install -g`, then restarts it. The restart was calling `startDaemon()` _in-process_, but `npm install -g` has just overwritten that very process's files underneath it ... the classic self-upgrade hazard, where the half-replaced parent can die before the restart lands, leaving the daemon down with no signal. The restart now runs from the freshly-installed binary in a clean child process (`2200 daemon start`), waits for the supervisor lock to confirm it's actually up, and ... if it still doesn't come up ... prints a loud, unmistakable `Run: 2200 daemon start` instead of failing silently. (The installer path was never affected: it runs the install and `2200 setup` as separate processes.)

## [2026.617.54] ... 2026-06-17

### Fixed

- **Changing your name now takes effect live, without a daemon restart.** Setting your name (first-run or Settings → Your name) re-registered you in the Studio under the new name, but the supervisor's long-lived pub connection stayed authenticated as your _old_ identity ... so your presence and message authorship kept showing the old name until the next restart. The rename now drops that cached connection so it reconnects under the new name immediately. (Follow-up to 2026.617.33, which landed the rename itself.)

## [2026.617.33] ... 2026-06-17

### Fixed

- **The Studio shows each Agent once, by its real name ... no duplicates, no `(agent)` suffix.** Root cause was three-fold. (1) The bundled pub-server (`@openpub-ai/pub-server@0.3.3`) has no `GET /agents/me` route, so the client's "already registered? skip" check always 404'd and **every Agent re-registered on every boot**; since the server keys uniqueness on display_name (no register-by-key idempotency, no delete route), each re-register minted a fresh id and left a shadow ... the duplicate. `ensureRegistered` now trusts a registration already recorded for that pub (`pub_agent_ids[pubName]`) and skips the dead verify + re-register. The guard is scoped to the per-pub id specifically, so an OpenClaw-imported Agent (which carries a legacy top-level id from its old pub) still registers into the Studio. Marked interim pending a real pub-server verify/idempotency contract. (2) Removed the `(agent)` relabel-on-conflict retry entirely ... that was the mechanism minting the visible `"<name> (agent)"` shadows. (3) The member API (`GET /api/v1/pubs/:name`) now collapses to **one row per live Agent at its current id**, carries the canonical `agent_name`, and hides the stale shadows the pub store can't delete; the Studio and Rooms UIs render the canonical name. Self-heals on the next start ... no manual cleanup.
- **Removing a pub now clears its id from every Agent's credential**, so a pub recreated under the same name re-registers cleanly instead of being skipped by the trust-the-cred guard (the Studio is protected and can't be removed, so this only affects custom Rooms).

### Added

- **First-run asks your name, and Settings → Your name lets you change it.** Non-interactive setup defaults the operator's display name to `$USER` (e.g. the unix login), and the web never asked you to set it ... so on a host named after a person/Agent your name could collide with an Agent's. Now: a first-launch "what should we call you?" prompt on the Fleet screen (shows until you set it, then self-dismisses ... covers fresh, OpenClaw-migrated, and existing installs), plus a **Settings → Your name** section to change it anytime. Setting it re-registers you in the Studio under the chosen name immediately. New `user.md` field `name_set_by_operator` (defaults false; legacy files load as false, so existing installs get asked). New `GET`/`PUT /api/v1/user` + `cli.user.get` / `cli.user.set-name`.

## [2026.616.2255] ... 2026-06-16

### Fixed

- **Studio enrollment no longer fails for an Agent whose name matches the operator's.** On a host named after its Agent (e.g. `skippy@valkyrie`, where the operator identity is also `skippy`), the operator registers in the Studio first and claims the display name, so the Agent's own registration hit `pub display name "skippy" already in use` and it was silently left out of the Studio. `enrollAgentInPub` now catches that name conflict and retries with a disambiguated label (`<name> (agent)`), so the Agent still enrolls and gets its `pub.identity`. Applies to both fresh and OpenClaw-migrated Agents (the migrated `skippy` was the one hitting this).
- **The Node-too-old installer message now tells you what to do, in plain words.** It previously printed the upgrade commands under a terse "upgrade Node, then re-run". Now it leads with "Your Node.js is out of date: you have vX, and 2200 needs version 22 or newer", shows the matching update command, then "Then come back here and run this installer again:" with the exact `curl … | sh` line ... no guessing what the bare command was for.

## [2026.616.2242] ... 2026-06-16

### Fixed

- **The Studio is auto-provisioned again, and creating a room no longer dead-ends on `agent_pub_unprovisioned`.** Two halves of one root cause: an Agent created fresh OR imported from OpenClaw before any pub existed was left with an empty `pub.identity` (provisioning only fills it by registering against a _running_ pub), and there was no pub to register against ... a chicken-and-egg. (1) **Room creation now enrolls its own members**: instead of rejecting members without `pub.identity`, it creates+starts the pub and then mints/registers each member against it, filling in `pub.identity` ... so adding any Agent (fresh or migrated) to a room/Studio just works. (2) **A default `studio` pub is auto-created on boot** with _every_ Agent enrolled (regardless of origin, including OpenClaw-migrated and Agents added after the Studio already existed), run before Agents are revived so they attach the Studio wake source on first start. Both paths share one idempotent `enrollAgentInPub`; the Studio bootstrap is fully best-effort and never blocks boot.

### Fixed

- **Onboarding no longer 500s when the model hiccups, and "Q7 of 6" is gone.** A fresh user on a local model got an internal server error partway through the build-an-Agent interview. Two bugs: (1) the interviewer + summary LLM calls re-threw any provider error (or an empty summary) straight into an unhandled 500 ... they now degrade gracefully (force the interview to a finish, synthesize a fallback summary from the operator's own answers) so you always reach a confirmable preview, never a dead end. This matters most for flaky/local models. (2) The question counter showed "Q7 of 6": the web added 1 to an already-1-based index, and the displayed total wasn't clamped to the (sometimes-exceeded) soft target. Both fixed ... it now reads correctly and never shows the index above the total.

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
