# AB-001 Repository identity refresh (Galinsky-2028/Ask-Bill)

**Repository:** `Galinsky-2028/Ask-Bill` (previously `neophilism/Ask-Bill`). **Base:** main `ebce28a1`.

## Why
After the repository moved, `scripts/validate-pr-registry.mjs` asserted `GITHUB_REPOSITORY === 'neophilism/Ask-Bill'`, so the `quality` job failed closed on every new PR (observed on PR #108). The registry identity, its retired-roadmap redirect and the PR snapshot URLs are bound to the live repository.

## Changes
- `scripts/validate-pr-registry.mjs`, `scripts/ready-work.mjs`, `tests/registry.test.mjs`, `registry/roadmap.json`, `scripts/export-offline-preview.mjs`: repository identity `Galinsky-2028/Ask-Bill`.
- `registry/prs.json`: `repository`, `observedAt` and a full refreshed `pullRequests` snapshot (107 genuine PRs #1–#108; #52 is an issue) read from the GitHub REST API. AB-055 gains contributing PRs #102–#104 (Meshy tooling only; status unchanged). AB-105 gains contributing PR #108 (open at observation).
- `docs/HANDOFF.md`: current repository name. Dated historical evidence files keep the identity observed at their time. Hashed approved sources (`docs/ARCHITECTURE.md`, `docs/DEVELOPMENT_PLAN.md`) are unchanged.

## Tests
`GITHUB_REPOSITORY=Galinsky-2028/Ask-Bill pnpm registry:validate` pass (112 units, 490 edges, 107 PRs); `node --test tests/registry.test.mjs` 6 pass; `pnpm check` pass; full `node --test tests/*.test.mjs` 634 pass.

## Status
No implementation or operational status changed. Rollback: revert this commit.

## CI runner pin (same PR, required to unblock it)
`.github/workflows/ci.yml` browser job: `ubuntu-latest` now resolves to Ubuntu 26.04, where the pinned Playwright 1.57.0 refuses to install Chromium ("Playwright does not support chromium on ubuntu26.04-x64", PR #108 run). The browser job is pinned to `ubuntu-24.04`. Both fixes are needed for any PR to pass, so they ship together.
