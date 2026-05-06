# TESTING — @restart/papercup-shared

## What this project's tests cover

- `_admin-paths.test.ts` — path-resolution helpers (per-workspace
  `papercuspPath()` etc.) — example-based tests.
- `_admin-paths.property.test.ts` — fast-check property tests for the
  same path helpers (round-trip, idempotence).

## What they don't cover

- Runtime database access (this lib reaches into shared schemas via
  `search_path`; integration coverage lives in `apps/operator/test/`).
- Briefings / plugin-config persistence wired in 2026-04-28 — covered
  via operator integration tests.

## Run after editing

| Edit touches                        | Run                                                   |
| ----------------------------------- | ----------------------------------------------------- |
| Anything in this workspace          | `npm test --workspace @restart/papercup-shared`       |
| Code that other workspaces depend on| `npm run test:affected` from repo root                |
| Briefings / plugin-config schema    | `npm run test:all:integration` (operator suite picks it up) |

See repo-root `CLAUDE.md` and `apps/operator/content/docs/testing/` for the full strategy.
