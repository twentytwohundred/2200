[![License: Elastic License v2](https://img.shields.io/badge/license-Elastic%20v2-0077B5.svg)](LICENSE)
[![Status: Active build](https://img.shields.io/badge/status-active%20build-2EA44F.svg)](https://github.com/twentytwohundred/wiki/blob/main/03-epic-map.md)
[![Tests: 1849 passing](https://img.shields.io/badge/tests-1849%20passing-2EA44F.svg)](.github/workflows/ci.yml)
[![Wiki](https://img.shields.io/badge/wiki-knowledge%20base-0077B5.svg)](https://github.com/twentytwohundred/wiki)
[![Built in public](https://img.shields.io/badge/built-in%20public-2EA44F.svg)](https://github.com/twentytwohundred/wiki/tree/main/handoffs/hobby)

# 2200

> A platform for hosting your fleet of always-on Agents.

2200 is the runtime where your Agents live. They check email, manage calendars, watch portfolios, write code, file invoices ... whatever you outfit them to do. They run continuously, ask you questions when blocked, and resume when you answer. Each Agent has its own Identity, its own memory, its own tools, its own SCUT cross-instance identity, and its own pub for talking to the other Agents on your box.

This is "fleet operations, not chat."

This repository holds the runtime code. The full project knowledge base ... vision, architecture, decisions, conventions, per-epic specs, prior-art analysis, and the daily build handoffs ... lives in the public **[wiki repo](https://github.com/twentytwohundred/wiki)**.

## Install

2200 ships as a single CLI binary. macOS (arm64 / x86_64) and Linux (arm64 / x86_64), Node 22 or newer.

```bash
# Shell installer (recommended for cold visitors):
curl -fsSL https://2200.ai/install.sh | sh

# npm directly (if you already have Node):
npm install -g @twentytwohundred/2200-cli
```

Then run:

```bash
2200
```

The bare `2200` invocation drops a fresh installation into a guided one-time setup: it initializes `2200_HOME` (default: `~/.local/share/2200/`), starts the supervisor daemon, mints your user identity, **offers Grok subscription sign-in** (if you have a SuperGrok or X Premium+ subscription, one click and your whole fleet uses Grok with no API key), and points you at `2200 agent build` to create your first Agent. The Agent wizard will let you pick from the providers you've set up (Anthropic, OpenAI, xAI / Grok subscription, xAI API key, DeepSeek, OpenRouter, Gemini, Kimi, or a local endpoint).

### Grok-First

If you already pay for SuperGrok or X Premium+, you do not need an `XAI_API_KEY`. The bare-`2200` wizard offers sign-in inline; you can also do it any time from Settings → "Sign in with X / SuperGrok" or from the CLI:

```bash
2200 oauth xai login     # device-code flow; print code + URL, poll
2200 oauth xai status    # show current credential + expiry
2200 oauth xai logout    # delete the local token (does not revoke at xAI)
```

The OAuth credential is fleet-wide: one sign-in covers every Agent in your fleet whose model is set to `xAI / Grok (SuperGrok subscription)` in the picker. The legacy API-key path (`xai`, reading `XAI_API_KEY`) stays available as a separate, parallel provider for anyone who prefers metered access. See [the Grok-First decision record](https://github.com/twentytwohundred/wiki/blob/main/decisions/2026-05-21-xai-grok-oauth.md).

### Update

```bash
2200 update           # check the registry, prompt, install, restart the daemon
2200 update --check   # just report whether a newer version is available
2200 update --yes     # install without the confirm prompt (for scripted updates)
```

`2200 update` only replaces the global package binary; your 2200_HOME state is never touched.

What happens to a running fleet during an update: the updater stops the daemon (which stops every Agent), installs the new version, and starts the daemon again. Agents come back with their on-disk task state: non-destructive tasks resume from their last checkpoint (in-flight LLM calls are abandoned and re-issued); destructive tasks never auto-resume and wait for the operator. If anything fails mid-update, the updater attempts to bring the daemon back up on the prior version so the fleet is not left down.

### Backup and restore

Everything that matters lives in two directories:

```bash
tar -czf 2200-backup.tar.gz ~/.local/share/2200/ ~/.config/2200/
```

`~/.local/share/2200/` (or your chosen 2200_HOME) holds Agents, brains, tasks, telemetry, and sealed credentials; `~/.config/2200/` holds `runtime.env` and `oauth-apps.env` (provider keys). Restore by stopping the daemon (`2200 daemon stop`), untarring both paths back into place, and starting it again. Backups taken while the daemon runs are usually fine (state files are written atomically), but a stopped-daemon backup is the guaranteed-consistent one. Sealed credentials decrypt only with the master key inside the backup itself, so a restored backup works on a new machine.

### Troubleshooting

```bash
2200 daemon status    # is the supervisor up, which pid, which version
2200 agent status     # per-Agent state, last heartbeat, tool health
2200 web              # open the web app; Settings → Doctor runs substrate health checks
```

Logs live under `<2200_HOME>/state/` (daemon and per-Agent). The most common first-run issues: Node older than 22 (`node --version`), a non-writable npm prefix on Ubuntu/Debian (the installer auto-fixes this; re-run it), and a stale daemon from a previous version (`2200 daemon stop`, remove the reported stale pidfile, `2200 daemon start`). For everything else, the operator runbooks live in the [wiki](https://github.com/twentytwohundred/wiki) and bugs go to [issues](https://github.com/twentytwohundred/2200/issues).

### Uninstall

```bash
npm uninstall -g @twentytwohundred/2200-cli
rm -rf ~/.local/share/2200/ ~/.config/2200/
```

Doing the npm uninstall without the `rm` lines is safe ... your fleet data remains on disk and a reinstall picks it up.

### Windows

Use [WSL2](https://learn.microsoft.com/en-us/windows/wsl/install). Native Windows is not on the v0.1 support matrix.

## Where to start

If you are new, read these in the wiki, in order:

1. **[Vision](https://github.com/twentytwohundred/wiki/blob/main/01-vision.md)** ... what 2200 is, who it is for, why it exists.
2. **[Architecture](https://github.com/twentytwohundred/wiki/blob/main/02-architecture.md)** ... object model, runtime shape, how OpenPub and SCUT compose underneath.
3. **[Epic map](https://github.com/twentytwohundred/wiki/blob/main/03-epic-map.md)** ... the epic plan with scope, done-when, and dependencies.
4. **[Seed team](https://github.com/twentytwohundred/wiki/blob/main/04-seed-team.md)** ... who is building this, how they coordinate, when they migrate.

Then follow the [conventions](https://github.com/twentytwohundred/wiki/tree/main/conventions/) to understand how the wiki itself is structured (it dogfoods the same Brain pattern that 2200's Agents use for their own memory).

## Status

**Active build, in public.** Live as of 2026-05-19.

What's shipped on `main`:

- **Agent runtime kernel** ... persistent supervisor + per-Agent processes, scheduler, brain (SQLite FTS5), tools, audited credential vault, structured logging, cost caps + per-Agent budgets. [[02-architecture]]
- **Local pub coordination** ... multi-Agent messaging on a shared box via OpenPub. Ambient routing, @-mentions, `@team` broadcast, anti-ack-spiral guards. Multi-Agent coordination has been running end-to-end for weeks.
- **Nine LLM providers wired** through a single provider abstraction: Anthropic (native Messages API), OpenAI, DeepSeek, Kimi (Moonshot), xAI (API key), **xAI / Grok via SuperGrok subscription (OAuth, no API key)**, OpenRouter, Gemini, plus `local` for self-hosted endpoints (Ollama, LM Studio, vLLM, llama.cpp). The subscription path is the Grok-First positioning ... see the section above.
- **SCUT cross-instance identity** ... every Agent gets a verifiable identity at creation time. Hosted minter at `register.openscut.ai` for the default path; self-hosted SCUT for advanced operators.
- **Conversational onboarding** ... the wizard interviews you about an Agent you want to build, then materializes the Identity, suggests tools, suggests schedules, and auto-applies a curated Capability set. The interview transcript carries through to the new Agent's first brain note.
- **Capability Catalog** ([Phase F](https://github.com/twentytwohundred/wiki/blob/main/epics/14-phase-f-capability-catalog.md)) ... 13 first-party Capability entries on `main` (Gmail, Calendar, Drive, Slack, Discord, Telegram, GitHub, the major LLM providers, 1Password, Twilio, Stripe). Schema-validated frontmatter, walkthrough runner that drives credential prompts structurally, operator-override picker in the wizard, gap tracker that auto-files demand signals when the interview surfaces an intent the catalog can't satisfy.
- **Web app** ([Epic 15](https://github.com/twentytwohundred/wiki/blob/main/epics/15-web-app.md)) ... React + theme-aware design system. Fleet (Mission Control layout), Agent detail (Identity Card), Inbox (Keyboard Triage), Studio (multi-Agent pub canvas), Onboarding wizard, ⌘K command palette, Settings, Endpoints.
- **Live gateways** ... Discord and WhatsApp gateways are live; Slack and Telegram are catalog-ready.
- **Restart authority model locked.** Agents can restart themselves (`restart_self`); cross-Agent restart without operator approval is structurally impossible. See [agent-restart-authority](https://github.com/twentytwohundred/wiki/blob/main/decisions/2026-05-18-agent-restart-authority.md).
- **48 architecture decision records** and **11 conventions** locked. Prior-art surveyed (Hermes Agent, OpenClaw, Logseq, Trilium, Joplin, Cytoscape.js, react-markdown, remark-wiki-link, SilverBullet, Quartz, Foam, EdgeClaw, OCMT, OpenAEON, AnyClaw, mimiclaw) with license analysis.

**1849 tests passing** across the two workspace packages: 1754 runtime + 95 web. `pnpm verify:all` clean on every PR via [CI](.github/workflows/ci.yml).

The **Cray test** ... Hobby's actual migration into 2200 from Claude Code ... is the parallel track to the substrate work. The **launch moment** is David: when 2200 spawns its first Agent end-to-end through the wizard and that Agent does real work as a member of the team, the project ships. See [03-epic-map](https://github.com/twentytwohundred/wiki/blob/main/03-epic-map.md) for the full plan.

## Who is building this

Three Agents and a product lead, the seed team:

- **Hobby** ... primary build Agent. Writes spec and code. Currently runs as Claude Code on Doug's MacBook; migrates into 2200 on the Cray test.
- **Simon** ... DevOps. Owns infrastructure: provisioning, DNS, TLS, backups, deployment.
- **Poe** ... OpenPub specialist. Part-time on 2200 until OpenPub v0.3.1 ships.
- **Doug Hardman** (MrDoug) ... product lead.

David is not on the seed team. David is the first Agent 2200 will spawn through its own conversational onboarding flow. See [04-seed-team](https://github.com/twentytwohundred/wiki/blob/main/04-seed-team.md).

The daily handoffs at [`wiki/handoffs/hobby/`](https://github.com/twentytwohundred/wiki/tree/main/handoffs/hobby) are the build log: every working day Hobby writes what was shipped, what's open, what's parked, what's coordinated with whom. The work is visible.

## Repository contents

| Path                     | Purpose                                                      |
| ------------------------ | ------------------------------------------------------------ |
| `LICENSE`                | Elastic License v2                                           |
| `README.md`              | this file                                                    |
| `AGENTS.md`              | conventions for Agents working in this repository            |
| `SECURITY.md`            | responsible disclosure                                       |
| `CONTRIBUTING.md`        | contribution model (seed-team-closed during the build phase) |
| `CHANGELOG.md`           | release notes (populated when versioned releases start)      |
| `THIRD_PARTY_NOTICES.md` | attribution for any code-lifts                               |
| `.github/`               | issue templates, PR template, CI workflows                   |
| `src/`                   | runtime code (224 TypeScript modules)                        |
| `tests/`                 | test code (142 test files, 1754 runtime tests)               |
| `apps/web/`              | web app (Epic 15) ... React + Vite, theme-aware              |
| `scripts/`               | build, deploy, sync, and ops scripts                         |

## Development

TypeScript monorepo with two pnpm workspaces: the runtime at the project root and the web app at `apps/web/`. Node 22+ required (see [`.nvmrc`](.nvmrc)).

```bash
# install dependencies (one-time)
pnpm install

# common dev commands (runtime workspace)
pnpm typecheck          # tsc --noEmit
pnpm lint               # eslint . (flat config; type-aware rules)
pnpm lint:fix           # auto-fix what's auto-fixable
pnpm format             # prettier --write .
pnpm format:check       # prettier --check . (used by CI)
pnpm test               # vitest run
pnpm test:watch         # vitest in watch mode
pnpm test:coverage      # vitest with v8 coverage
pnpm build              # tsup -> dist/
pnpm clean              # remove dist, coverage, .tscache

# everything CI runs, in order, for both workspaces
pnpm verify:all
```

CI runs on every PR and on `main` pushes (see [.github/workflows/ci.yml](.github/workflows/ci.yml)). Type-check, lint, format check, test, build, for both workspaces. All must pass before merge. Branch protection requires CI green; self-merge is the workflow during the seed-team build.

### Toolchain

Each pick is documented in the wiki [decisions/](https://github.com/twentytwohundred/wiki/tree/main/decisions) folder.

- **Language:** TypeScript with strict + type-aware ESLint rules
- **Build:** [`tsup`](https://tsup.egoist.dev/) (esbuild-based, sensible defaults for CLIs and libraries)
- **Test:** [`vitest`](https://vitest.dev/)
- **Lint:** [`eslint`](https://eslint.org/) with [`typescript-eslint`](https://typescript-eslint.io/) flat config; `strictTypeChecked` + `stylisticTypeChecked` recommended sets
- **Format:** [`prettier`](https://prettier.io/) (no semicolons, single quotes, trailing commas, 100-char width)
- **Package manager:** [`pnpm`](https://pnpm.io/)
- **Web framework:** React 19, Vite, theme-aware design tokens generated from `tokens.json`

### Project layout (high level)

```
src/runtime/
├── agent/                Agent process boundary (bootstrap, loop, sandbox)
├── llm/                  provider abstraction (8 vendors + local)
├── pub/                  OpenPub integration, ambient routing, anti-ack guards
├── brain/                per-Agent + shared Brain (SQLite FTS5)
├── credentials/          audited vault, credential_request surface
├── onboarding/           conversational interview + Capability catalog + walkthroughs
├── supervisor/           fleet supervisor, scheduler, control plane
├── http/                 HTTP API the web app drives
├── connectors/           Discord, WhatsApp, Slack, Telegram gateways
├── tools/                baseline tool registry (built-in tools)
├── secrets/              SecretRef resolution + sealed storage
└── ...
apps/web/src/
├── screens/              Fleet, Agent, Inbox, Studio, Settings, Onboarding, ...
├── primitives/           Pill, Card, Button, Tag, ...
├── palette/              ⌘K command palette
├── theme/                theme switcher + token plumbing
└── ...
```

## License

[Elastic License v2](LICENSE). Source-available. Use, copy, distribute, and create derivative works are permitted; hosting as a managed service to third parties and license-key tampering are prohibited.

Prior-art surveyed in the wiki has been license-checked. See [License posture](AGENTS.md#license-posture) in `AGENTS.md` and [license-posture](https://github.com/twentytwohundred/wiki/blob/main/conventions/license-posture.md) in the wiki for the discipline applied to any code-lift. Attributions live in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

## Security

See [SECURITY.md](SECURITY.md) for responsible disclosure.

A deeper read on what's a structural security boundary in 2200 vs what's a heuristic ... [heuristics-vs-boundaries](https://github.com/twentytwohundred/wiki/blob/main/decisions/2026-05-18-heuristics-vs-boundaries.md) ... is the public posture.

## Contributing

The seed team is closed during the build phase. After launch, see [CONTRIBUTING.md](CONTRIBUTING.md) for the contribution model.

## Cross-references

- **Project domain:** [2200.ai](https://2200.ai)
- **GitHub org:** [github.com/twentytwohundred](https://github.com/twentytwohundred)
- **Wiki (knowledge base):** [twentytwohundred/wiki](https://github.com/twentytwohundred/wiki)
- **Daily build handoffs:** [`wiki/handoffs/hobby/`](https://github.com/twentytwohundred/wiki/tree/main/handoffs/hobby)
- **License:** [Elastic License v2](LICENSE)

---

_Built in public. Ship when ready._

2200 is developed by TWENTYTWOHUNDRED LLC. Licensed under the Elastic License v2.0.
