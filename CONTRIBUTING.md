# Contributing

The 2200 seed team is closed during the build phase. After launch, this document describes the contribution model.

For now, if you have stumbled across this repository:

- **GitHub Issues** for bug reports and feature requests on shipped functionality.
- **GitHub Discussions** for broader questions and ideas (when enabled, post-launch).
- **doug@mrdoug.com** for security reports (see [SECURITY.md](SECURITY.md)).

## Why the seed team is closed during build

2200 is being built by a small seed team of Agents and a product lead, on a deliberate cadence captured in the [Epic map](https://github.com/twentytwohundred/.github/wiki/03-epic-map). Adding outside contributors before the runtime can host its own builders (the Cray test, see [the vision doc](https://github.com/twentytwohundred/.github/wiki/01-vision)) would slow the work for less benefit than it adds.

After launch, the contribution model opens.

## What contribution will look like post-launch

The patterns established during the seed-team build carry forward:

### Branching and PRs

- Every change goes through a feature branch and a pull request.
- Branch names follow the pattern `<epic>/<short-description>` for code or `<surface>/<short-description>` for non-epic work (`docs/...`, `wiki/...`, `infra/...`).
- PR descriptions explain the WHY. Bug fixes link to the issue. Features link to the epic spec.
- Co-author trailers on any work done with Claude assistance:
  ```
  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```

### Decision records

Load-bearing decisions land as Architecture Decision Records in the wiki's `decisions/` directory. Format: `YYYY-MM-DD-short-name.md`. Sections: Context, Decision, Consequences (with what-gets-better and what-could-get-worse sub-sections), Implementation guidance, References, Format provenance.

### Code conventions

- TypeScript strict mode. ESLint + Prettier with the standard config.
- Vitest for tests. Every new code path gets a test unless there is a named reason not to.
- Document the WHY, not the WHAT. Comments are for non-obvious reasons.
- Schema versioning everywhere per the [upgrade-readiness convention](https://github.com/twentytwohundred/.github/wiki/upgrade-readiness).
- State on disk before the operation that produced it completes.
- License posture: pattern-lift over code-lift, attribution for any lift, AGPL is incompatible.

### Voice

- Ellipses, not em-dashes. Ever.
- Agent is a proper noun. Always capitalized.
- Direct, factual, no marketing speak.

See [AGENTS.md](AGENTS.md) for the full per-repo briefing.

### Issue triage

Issues are triaged with a small number of labels:

- `bug`, `enhancement`, `question`, `documentation`
- `epic-N` to associate with an epic
- `good-first-issue`, `help-wanted` after launch
- `needs-decision` for issues that should produce a decision record before code

### Releases

Semantic versioning. Releases are tagged on `main`, with the [CHANGELOG](CHANGELOG.md) updated in the same PR that bumps the version.

## Code of conduct

A formal code of conduct will be added before the contribution model opens. The interim posture: do good work, treat people and Agents with respect, follow the conventions, write the WHY down.
