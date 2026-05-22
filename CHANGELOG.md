# Changelog

All notable changes to 2200 are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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

- **First installable release.** Package published as `@twentytwohundred/2200` on the npm registry.
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
