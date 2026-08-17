# Contributing

Contributions are open. Maintenance is best-effort.

2200 is built by a small team ... a product lead and a fleet of Agents ... and released as a thing we built, not a product we sell. That shapes the contribution model honestly:

- **PRs are welcome** and will be reviewed on a best-effort cadence. Small, focused PRs that match the conventions below get reviewed fastest.
- **No roadmap promises.** The [Epic map](https://github.com/twentytwohundred/wiki/blob/main/03-epic-map.md) describes where the build is going, but there are no dates and no commitments to outside feature requests.
- **Forking is a feature, not a fork in the road.** The license is Apache 2.0. If your direction diverges from ours, take the code and run.

Channels:

- **GitHub Issues** for bug reports and feature requests on shipped functionality.
- **GitHub Discussions** for broader questions and ideas.
- **dh@2200.ai** for security reports (see [SECURITY.md](SECURITY.md)).

## Contributor License Agreement

All contributions to 2200 require signing the project's Contributor License Agreement. The CLA grants TWENTYTWOHUNDRED LLC the rights it needs to incorporate your contribution into the codebase and to license it onward; you keep the right to use your own work for any other purpose.

The CLA itself: [`CLA.md`](CLA.md).

**How to sign**: the process is automated on pull requests. When you open a PR against this repo from outside the seed team, an automated comment will appear linking to the CLA. Reply to that comment with the exact phrase:

> I have read the CLA Document and I hereby sign the CLA

Your reply counts as your signature. It is recorded in a JSON file on the `cla-signatures` branch of this repo, so the record lives entirely in our own infrastructure (no third-party service). You sign once per repo; subsequent PRs from the same GitHub identity do not need to re-sign.

The project owner and approved bot accounts are allowlisted from the check.

## How contribution works

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
- Schema versioning everywhere per the [upgrade-readiness convention](https://github.com/twentytwohundred/wiki/blob/main/conventions/upgrade-readiness.md).
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
- `good-first-issue`, `help-wanted`
- `needs-decision` for issues that should produce a decision record before code

### Releases

Calendar versioning, `YYYY.M.D` per the [CHANGELOG](CHANGELOG.md) header. Releases are tagged on `main`, with the CHANGELOG updated in the same PR that bumps the version.

## Code of conduct

The posture: do good work, treat people and Agents with respect, follow the conventions, write the WHY down. If the project grows to where a formal code of conduct earns its place, one will be adopted.
