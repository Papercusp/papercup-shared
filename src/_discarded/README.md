# Discarded components

Components removed from active use but kept here in case we want to revive them.
Nothing in this folder is exported from `index.ts` and nothing imports from here.

## Inventory

### `HarnessOpsCockpit.tsx`
Removed in Round 39. Was the top half of `HarnessesView` — KPI strip, per-dept
cards with Run-now / Auto-toggle / View-latest-run / Stale badges, "Run N stale"
bulk button, Active-runs panel, Backlog cards, Recent-audit feed.

**Why removed**: every per-dept control is already accessible by switching to
that dept's project in the embedded `HarnessDashboard` project dropdown
(which routes to `/harness/org-<dept>` with its 8-tab `DepartmentHarnessDashboard`
including Inbox/Outbox/Compose/Decisions/Charter/Notes/Memory/Director-agent).
The only truly unique bit was the org-wide aggregate (totals + audit feed),
which the user judged unnecessary at this stage.

**To revive**: re-export from `index.ts` and import wherever needed. The
component still polls `/api/org/health-snapshot` and accepts an `initialData`
seed for SSR/readOnly contexts.
