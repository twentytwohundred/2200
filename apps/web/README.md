# 2200 web app

Browser UI for the 2200 runtime. Talks to the runtime over the documented
HTTP + WebSocket API at [`wiki/conventions/runtime-api.md`](https://github.com/twentytwohundred/wiki/blob/main/conventions/runtime-api.md).
Theme-aware from v1 per the [theme-aware decision](https://github.com/twentytwohundred/wiki/blob/main/decisions/2026-04-29-theme-aware-from-v1.md).

## Status

Phase A scaffold. Vite + React + TypeScript + Vitest. Renders a smoke
page that uses the canonical token system inline. Real screens land in
follow-up PRs in the `epic-15/*` branch family per
[`wiki/epics/15-web-app.md`](https://github.com/twentytwohundred/wiki/blob/main/epics/15-web-app.md).

## Local dev

From `code/2200/`:

```bash
pnpm install                                   # installs both runtime + web
pnpm --filter @twentytwohundred/web dev        # vite dev server on :5173
pnpm --filter @twentytwohundred/web verify     # typecheck + lint + format + test + build
```

Or from `code/2200/apps/web/`:

```bash
pnpm dev
pnpm verify
```

## Boundary discipline

The web app does not import runtime types or call runtime functions. It
talks to the runtime over the API only. ESLint enforces this via a
`no-restricted-imports` rule that blocks `../../src/*`, `../../../src/*`,
`@runtime/*`, and `@2200/runtime/*` patterns.

When the runtime ships a new field, the frontend's types regenerate from
the JSON Schema published at `/api/v1/schema`. There is no shared
TypeScript universe between runtime and frontend.

## Tokens

The tokens at `src/tokens.css` are a bootstrap slice mirroring the
canonical source at
[`wiki/design-system/tokens.json`](https://github.com/twentytwohundred/wiki/blob/main/design-system/tokens.json).
A follow-up PR replaces this static file with a build-time generator
that reads the canonical JSON. Variable names and values match, so the
swap is non-breaking.
