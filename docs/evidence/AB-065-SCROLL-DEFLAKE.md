# AB-065 scroll-invalidation browser check de-flake

**Symptom:** `tests/browser/test_layout_anchor_registry.py` intermittently failed with "scroll must invalidate geometries" (observed on PR #111, passed on rerun).

**Cause:** `window.scrollTo()` updates `scrollY` synchronously, but browsers dispatch the `scroll` event on a later animation frame. The test waited only for `scrollY >= 30`, then immediately asserted the registry revision was stale, racing the event the registry listens to (`packages/character/layout/registry.mjs` `install(win,'scroll',…)`).

**Fix (test only):** after the scroll, wait up to 5 s for `window.__registry.layoutRevision` to change before asserting. A registry that never invalidates on scroll still fails (timeout), and the stale-revision assertion is unchanged. No product code changes.

**Evidence:** local Chrome + Playwright 1.57.0, 5 consecutive passes; CI browser job on the PR head.
