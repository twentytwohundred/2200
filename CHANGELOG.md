# Changelog

All notable changes to 2200 are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Repository scaffolding: LICENSE, README, AGENTS.md, SECURITY.md, CONTRIBUTING.md, CHANGELOG.md, THIRD_PARTY_NOTICES.md, `.github/` templates and CI workflow.
- Public wiki on `twentytwohundred/.github`, published from canonical Brain-format source via `scripts/publish-wiki.sh` in the `twentytwohundred/wiki` repo.
- Spec scaffolding (in the wiki): vision, architecture, epic map, seed team, seventeen decision records, five conventions, multiple epic specs, two design docs, prior-art analysis with deep findings appendix.
- **Epic 2: Agent runtime minimum.** Shipped. Supervisor, Identity loader, Brain (filesystem-first per [decision record](https://github.com/twentytwohundred/.github/wiki/2026-04-24-brain-is-files-not-database)), baseline tool set, plan/run/perm wrapping on every tool call, integer schema versioning everywhere, control-plane protocol over UDS+JSON-RPC.
- **Epic 3: Local pub integration via OpenPub.** Shipped. Pub supervision substrate, user and Agent pub identities, four pub MCP tools, WebSocket wake source, end-to-end smoke test against `@openpub-ai/pub-server@0.3.3`.
- **Epic 3.5: Two-agent demo.** Shipped. Hobby↔Simon coordination on the seed-team box, with the published runbook reproducible end-to-end.
- **Epic 3.6: Multi-provider and ambient routing.** Shipped. Six LLM providers wired (Anthropic native; OpenAI, DeepSeek, Kimi, OpenRouter, Gemini via the OpenAI-compatible adapter and `OPENAI_COMPATIBLE_VENDORS` table). Pub message router service with per-pub roster sidecars, opt-in via `ROUTER_PROVIDER` and `ROUTER_MODEL_ID`.
- **Epic 3.7: Followup model and chat polish.** Shipped. `Identity.model.followup_model_id` for two-tier model selection per Agent. Chat status notices.
- **Epic 3.8: Multi-Agent ack-spiral fix.** Shipped. Structural guards in the wake source: skip the router when sender is a known Agent; respect explicit `@`-mentions; per-pub roster self-upsert on Agent start; complete-roster perspective in router input.
- Local `pnpm patch` for `@openpub-ai/pub-server@0.3.3` (keepalive listener and bartender-guard fixes), to be dropped when v0.3.4 ships upstream. See [openpub-ai/openpub#1](https://github.com/openpub-ai/openpub/issues/1).

### Notes

- No tagged releases yet. Versioning begins when the runtime is feature-complete enough for the first public preview.
- The `wiki/` feature on this repo is disabled; the published wiki lives at [twentytwohundred/.github/wiki](https://github.com/twentytwohundred/.github/wiki). Canonical source: [twentytwohundred/wiki](https://github.com/twentytwohundred/wiki) (private).

[Unreleased]: https://github.com/twentytwohundred/2200/commits/main
