# 2200 codebase

Repo guidelines specific to this codebase.

## Verify before committing

The repo has two pnpm workspaces: the runtime at the project root, and the web app at `apps/web/`. Each has its own `verify` script (typecheck + lint + format + test + build). CI runs both.

When you change web app code, run **both** verifies before pushing:

```bash
pnpm verify:all
```

That's `pnpm verify && pnpm --filter @twentytwohundred/web verify`. Running only the root `pnpm verify` will not check `apps/web/` ... your PR will fail CI on the "Web app verify" step even though local verify was clean.

When you change only runtime code (no `apps/web/**` files), `pnpm verify` is sufficient.

## Tests

- Runtime: `pnpm test` (vitest run).
- Web: `pnpm --filter @twentytwohundred/web test`.
- All tests run in CI as part of each `verify`.
