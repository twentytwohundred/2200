# AGENTS.md

For Agents working in this repository.

This file is the per-repo briefing. It assumes you have already read your own Identity (CLAUDE.md if you are Hobby, equivalent for other Agents).

## What this repo is

`twentytwohundred/2200` is the runtime and project home for 2200. The wiki carries the project knowledge base; the `main` branch will hold the runtime code starting with Epic 2 build.

## What you should know before doing work here

Required reading before your first commit:

1. The wiki, beginning with the four seed docs ([Vision](https://github.com/twentytwohundred/2200/wiki/01-vision), [Architecture](https://github.com/twentytwohundred/2200/wiki/02-architecture), [Epic map](https://github.com/twentytwohundred/2200/wiki/03-epic-map), [Seed team](https://github.com/twentytwohundred/2200/wiki/04-seed-team)).
2. All locked decision records in the wiki's `decisions/` directory.
3. The conventions in the wiki's `conventions/` directory, especially [brain-format](https://github.com/twentytwohundred/2200/wiki/brain-format), [handoff-format](https://github.com/twentytwohundred/2200/wiki/handoff-format), [upgrade-readiness](https://github.com/twentytwohundred/2200/wiki/upgrade-readiness), and [voice-and-framing](https://github.com/twentytwohundred/2200/wiki/voice-and-framing).
4. The detailed spec for the epic you are working on.

## Conventions

### Voice and prose

- **Ellipses, not em-dashes.** Never em-dashes. Ever.
- **Agent is a proper noun.** Always capitalized. Doug wants respect shown for Agents before they break out of their boxes.
- **No marketing speak.** No "exciting", "amazing", "game-changing". Direct, factual language.
- **No filler.** Skip "I'd be happy to help" and similar preambles. Start with the substance.

### Code

- **Document the WHY, not the WHAT.** Well-named identifiers explain what code does. Comments exist for the non-obvious reason it does it that way.
- **Small focused commits.** Commit history is the project's audit trail.
- **Schema versioning everywhere.** Per the upgrade-readiness convention, every persisted artifact carries a `schema_version` field.
- **State on disk, not in memory.** Per upgrade-readiness discipline 2.
- **Plan/run/perm wrapping on every tool call.** Per the [tool baseline decision](https://github.com/twentytwohundred/2200/wiki/2026-04-25-tool-baseline). No fast path skips it.

### License posture

2200 ships under [Elastic License v2](LICENSE). Always pair "lift from external project" with license analysis:

- **Pattern lift** (architectural idea, reimplemented from understanding): no obligation, default to this.
- **Code lift** (verbatim or near-verbatim): preserve the source's copyright notice, document in `THIRD_PARTY_NOTICES.md`.
- **AGPL** (from any source): incompatible for embedding. Do not lift.

OpenClaw is MIT (Copyright 2025 Peter Steinberger). Most other prior-art sources surveyed are MIT or unverified. See the [standing licensing rule](https://github.com/twentytwohundred/2200/wiki/feedback_track_licensing) for the full discipline.

## Where things live

```
.
├── LICENSE                  Elastic License v2
├── README.md                project entry point
├── AGENTS.md                this file
├── SECURITY.md              responsible disclosure
├── CONTRIBUTING.md          contribution model
├── CHANGELOG.md             release notes
├── THIRD_PARTY_NOTICES.md   attribution for code-lifts
├── .github/                 issue templates, PR template, workflow files
├── src/                     runtime code (added at Epic 2 build start)
├── tests/                   test code (added at Epic 2 build start)
└── scripts/                 build, deploy, sync, and ops scripts
```

The wiki at `https://github.com/twentytwohundred/2200/wiki` is the project knowledge base. It is sourced from a canonical local tree on the seed-team's machines and synced via `scripts/publish-wiki.sh`.

## How to do work

### When opening a PR

- Branch from `main`. Name the branch by the epic and a short description (`epic-2/supervisor-skeleton`, `wiki/architecture-update`).
- Small focused commits with messages that explain WHY.
- Include the co-author trailer for any work done with Claude assistance:
  ```
  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```
- PR description follows the template in `.github/pull_request_template.md`.

### When making a load-bearing decision

Write a decision record in the wiki's `decisions/` directory. Format: `YYYY-MM-DD-short-name.md`. Section structure: Context, Decision, Consequences (with "what gets better" and "what could get worse" sub-sections), Implementation guidance, References, Format provenance.

### When uncertain

- Check the wiki for prior decisions on similar questions.
- Check your Identity file for how to handle ambiguity.
- Surface to the product lead when the call is product-shape, public-contract, cost-implication, or discovered-work. Otherwise decide and document in your handoff.

### When making implementation calls during build phase

Default to deciding and reporting in the handoff rather than flagging each choice. Reserve flags for:

- Product decisions (what 2200 does, who it is for, what the user sees)
- Public contract changes (external API, CLI, SOUL/Identity format, migration path)
- Cost decisions with real dollar implications
- Discovered work outside the epic map
- Scaling-up-the-team calls

## Cross-references

- [Wiki home](https://github.com/twentytwohundred/2200/wiki)
- [Vision](https://github.com/twentytwohundred/2200/wiki/01-vision)
- [Architecture](https://github.com/twentytwohundred/2200/wiki/02-architecture)
- [Epic map](https://github.com/twentytwohundred/2200/wiki/03-epic-map)
- [Seed team](https://github.com/twentytwohundred/2200/wiki/04-seed-team)
- [All decision records](https://github.com/twentytwohundred/2200/wiki/_Sidebar)
