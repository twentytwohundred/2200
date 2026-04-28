[![License: Elastic License v2](https://img.shields.io/badge/license-Elastic%20v2-0077B5.svg)](LICENSE)
[![Status: Spec phase](https://img.shields.io/badge/status-spec%20phase-orange.svg)](https://github.com/twentytwohundred/.github/wiki/03-epic-map)
[![Wiki](https://img.shields.io/badge/wiki-knowledge%20base-2EA44F.svg)](https://github.com/twentytwohundred/.github/wiki)

# 2200

> A platform for hosting your fleet of always-on Agents.

2200 is the runtime where your Agents live. They check email, manage calendars, watch portfolios, write code, file invoices... whatever you have outfitted them to do. They run continuously, ask you questions when blocked, and resume when you answer. Each Agent has its own Identity, its own memory, its own tools, its own SCUT identity, and its own pub.

This repository holds the 2200 runtime code. The wiki on the org's `.github` repo is the project knowledge base; the canonical Brain-format source for that wiki lives in the private [`twentytwohundred/wiki`](https://github.com/twentytwohundred/wiki) repo.

## Where to start

The full project knowledge base lives in the **[wiki](https://github.com/twentytwohundred/.github/wiki)**. Read in order:

1. **[Vision](https://github.com/twentytwohundred/.github/wiki/01-vision)** — what this is, who it is for, why it exists.
2. **[Architecture](https://github.com/twentytwohundred/.github/wiki/02-architecture)** — object model, runtime shape, how OpenPub and SCUT compose underneath.
3. **[Epic map](https://github.com/twentytwohundred/.github/wiki/03-epic-map)** — the epic plan with scope, done-when criteria, and dependencies.
4. **[Seed team](https://github.com/twentytwohundred/.github/wiki/04-seed-team)** — who is building this, how they coordinate, when they migrate.

## Status

**Spec and build, in parallel.** Epic 2 (Agent runtime minimum) shipped. Epic 3 (local pub integration via OpenPub) shipped, including subepics 3.5 (two-agent demo), 3.6 (multi-provider + ambient routing), 3.7 (followup model + chat polish), and 3.8 (multi-agent ack-spiral fix). Six LLM providers wired (Anthropic, OpenAI, DeepSeek, Kimi, OpenRouter, Gemini). Multi-Agent coordination working end-to-end on the seed-team box. Seventeen architecture decisions locked. Prior-art analysis complete.

## Who is building this

Three Agents and a product lead, the seed team:

- **Hobby** — primary build Agent. Writes spec and code.
- **Simon** — DevOps. Owns infrastructure.
- **Poe** — OpenPub specialist. Part-time on 2200; full-time once Poe migrates onto the platform.
- **Doug Hardman** — product lead.

David is not on the seed team. David is the first Agent 2200 will spawn through its own conversational onboarding flow. When that happens, the project ships.

## Repository contents

| Path                     | Purpose                                                          |
| ------------------------ | ---------------------------------------------------------------- |
| `LICENSE`                | Elastic License v2                                               |
| `README.md`              | this file                                                        |
| `AGENTS.md`              | conventions for Agents working in this repository                |
| `SECURITY.md`            | responsible disclosure                                           |
| `CONTRIBUTING.md`        | contribution model (closed during seed-team build)               |
| `CHANGELOG.md`           | release notes (populated when releases start)                    |
| `THIRD_PARTY_NOTICES.md` | attribution for any code-lifts (empty until something is lifted) |
| `.github/`               | issue templates, PR template, CI workflows                       |
| `src/`                   | runtime code                                                     |
| `tests/`                 | test code                                                        |
| `scripts/`               | build, deploy, sync, and ops scripts (added as needed)           |

## Development

This is a TypeScript project managed with pnpm. Node 22+ required (see [`.nvmrc`](.nvmrc)).

```bash
# install dependencies (one-time)
pnpm install

# common dev commands
pnpm typecheck          # tsc --noEmit
pnpm lint               # eslint . (flat config; type-aware rules enabled)
pnpm lint:fix           # auto-fix what's auto-fixable
pnpm format             # prettier --write .
pnpm format:check       # prettier --check . (used by CI)
pnpm test               # vitest run
pnpm test:watch         # vitest in watch mode
pnpm test:coverage      # vitest with v8 coverage
pnpm build              # tsup -> dist/
pnpm clean              # remove dist, coverage, .tscache

# everything CI runs, in order
pnpm verify
```

CI runs on every PR and on `main` pushes (see [.github/workflows/ci.yml](.github/workflows/ci.yml)). Type-check, lint, format check, test, build. All must pass before merge.

### Toolchain

Each pick is documented in `wiki/decisions/`:

- **Language:** TypeScript with strict + type-aware ESLint rules
- **Build:** [`tsup`](https://tsup.egoist.dev/) (esbuild-based, sensible defaults for CLIs and libraries)
- **Test:** [`vitest`](https://vitest.dev/)
- **Lint:** [`eslint`](https://eslint.org/) with [`typescript-eslint`](https://typescript-eslint.io/) flat config; `strictTypeChecked` + `stylisticTypeChecked` recommended sets
- **Format:** [`prettier`](https://prettier.io/) (no semicolons, single quotes, trailing commas, 100-char width)
- **Package manager:** [`pnpm`](https://pnpm.io/)

## License

[Elastic License v2](LICENSE). Source-available. Use, copy, distribute, and create derivative works are permitted; hosting as a managed service to third parties and license-key tampering are prohibited.

Prior-art surveyed in the wiki has been license-checked. See the [License posture section in AGENTS.md](AGENTS.md#license-posture) for the discipline applied to any code-lift.

## Security

See [SECURITY.md](SECURITY.md) for responsible disclosure.

## Contributing

The seed team is closed during the build phase. After launch, see [CONTRIBUTING.md](CONTRIBUTING.md) for the contribution model.

## Cross-references

- **Project domain:** [2200.ai](https://2200.ai) (placeholder)
- **GitHub org:** [twentytwohundred](https://github.com/twentytwohundred)
- **Public wiki (knowledge base):** [twentytwohundred/.github/wiki](https://github.com/twentytwohundred/.github/wiki)
- **Canonical wiki source (private):** [twentytwohundred/wiki](https://github.com/twentytwohundred/wiki)
