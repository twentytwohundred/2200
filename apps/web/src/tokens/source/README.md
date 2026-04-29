# Tokens source (vendored)

This directory holds a vendored copy of the canonical token source. The original lives in the wiki at:

```
wiki/design-system/tokens.json
```

Vendoring keeps CI hermetic (no cross-repo fetch needed) and makes token changes a deliberate, reviewable PR step instead of an implicit dependency on the wiki repo's state.

## Updating the vendored copy

When the canonical `wiki/design-system/tokens.json` changes:

```bash
# from code/2200/
cp ../../wiki/design-system/tokens.json apps/web/src/tokens/source/tokens.json
pnpm --filter @twentytwohundred/web run generate:tokens
git add apps/web/src/tokens/
```

Commit the source + generated CSS in the same PR so reviewers see both.

## Why a vendored copy and not a direct read

- **CI hermeticity.** GitHub Actions only checks out one repo at a time; reading from `../../wiki/...` works on Doug's machine (Dropbox-synced) but breaks in CI.
- **Versioning.** A token change should be a deliberate code-side PR, not implicit on every wiki commit.
- **Reproducibility.** Anyone cloning the code repo has everything they need to build.

## Drift protection

The CI workflow runs `pnpm run generate:tokens` and then `git diff --exit-code` on `apps/web/src/tokens/generated/`. If the generated CSS does not match what was committed, CI fails. So the source and generated dirs are guaranteed to be in lockstep on `main`.
