# Ask Bill — verified development checkpoint

GitHub observation: **2026-11-15T18:41Z**, repository `Galinsky-2028/Ask-Bill` (formerly `neophilism/Ask-Bill`), main `87a36f45`.

## Merged in this session (all five required jobs green on each exact head)

| PR | Unit | Result |
| --- | --- | --- |
| #109 | AB-001 | Registry bound to `Galinsky-2028/Ask-Bill` (the old identity failed every PR's quality job); browser CI job pinned to `ubuntu-24.04` (Playwright 1.57 rejects 26.04) |
| #108 | AB-105 (partial) | `ASK_BILL_OWNER_IDENTITY=deferred` bootstrap; `infra/start-web.sh` runs owner-only maintenance in separate processes, then starts web without owner values |
| #106 | AB-094 (partial) | Publisher tour/translation drafts, readiness classifier, failed-import retry; migrations 010/011 |
| #110 | AB-103 (partial) | Aggregate privacy-minimized telemetry, token-gated `/health/metrics`, `infra/alerts/rules.json` |
| #111 | AB-102 (partial) | Spend-safe reader load harness and local baseline |

Draft PR #105 (AB-048 character topology) remains open and untouched. The browser job's scroll-invalidation check (`test_layout_anchor_registry.py`) failed once on #111 and passed on rerun; treat it as flaky.

## Hosted staging (live, providers off)

- **Render** free web service `ask-bill`, ID `srv-dbsvlm0ae00c7397us50`, region Ohio, Docker (`infra/Dockerfile`), branch `main`, auto-deploy **off**, health check `/health/ready`. URL <https://ask-bill.onrender.com>. Deploys on 2026-11-15 reached `live` (Render requires a passing health check); startup logs show `mode:"published-source"`, AI/voice/transcription off.
- **Neon** project `Ask Bill`, ID `winter-waterfall-73466147`, `aws-us-east-2`, PostgreSQL 17, database `neondb`. All 13 migrations applied. The web service connects as the restricted `ask_bill_runtime` role. The owner URL is not on the service; get it from the Neon console only for maintenance.
- Publisher `9eca01ac-5317-4442-894e-6f63ea23fdc1` (slug `ask-bill`), owner user `0eb93068-5bea-4d28-b463-76f65ed87247`, **no login identity enrolled yet** (deferred).
- Service env: `ASK_BILL_STAGE=staging`, `ASK_BILL_PUBLIC_ORIGIN`, `ASK_BILL_PUBLISHER_ID`, `ASK_BILL_DATABASE_URL`, `ASK_BILL_SESSION_ENCRYPTION_KEY`, `ASK_BILL_METRICS_TOKEN`, limits, and every `ASK_BILL_ALLOW_*=false`. No secret values are in the repository.
- The public catalog is **empty**: nothing has been reviewed and published. No custom domain. The paid worker is not provisioned.

## Enabling features (owner inputs, set on the Render service)

1. **Publisher login + storage** (needed to publish anything): an OIDC provider with MFA → `ASK_BILL_OIDC_ISSUER`, `ASK_BILL_OIDC_CLIENT_ID`, `ASK_BILL_OIDC_CLIENT_SECRET` (callback `https://ask-bill.onrender.com/admin/auth/callback`); S3-compatible private bucket → `ASK_BILL_STORAGE_URL`, `ASK_BILL_STORAGE_BUCKET`, `ASK_BILL_STORAGE_ACCESS_KEY_ID`, `ASK_BILL_STORAGE_SECRET_ACCESS_KEY` (+ `ASK_BILL_STORAGE_REGION`). Enroll the owner login once: set `ASK_BILL_MIGRATION_DATABASE_URL` (Neon owner URL), `ASK_BILL_OWNER_USER_ID` (above), `ASK_BILL_PUBLISHER_SLUG=ask-bill`, `ASK_BILL_PUBLISHER_NAME=Ask Bill`, `ASK_BILL_RUNTIME_DB_ROLE=ask_bill_runtime`, `ASK_BILL_OWNER_OIDC_SUBJECT`, deploy, confirm `identityEnrolled:true` in logs, then delete the one-time values. Then `ASK_BILL_ALLOW_PUBLISHING=true`.
2. **AI answers**: `ASK_BILL_LLM_API_KEY`, `ASK_BILL_LLM_MODEL`, `ASK_BILL_REVIEW_MODEL` (different models), `ASK_BILL_PROVIDER_DATA_PROTECTION=verified`, `ASK_BILL_ALLOW_LIVE_AI=true`.
3. **Voice**: `ASK_BILL_TTS_API_KEY`, `ASK_BILL_VOICE_RIGHTS=verified`, `ASK_BILL_ALLOW_VOICE=true`; **transcription**: `ASK_BILL_STT_API_KEY`, `ASK_BILL_ALLOW_TRANSCRIPTION=true` (both also need the data-protection flag).
4. **Official Congress imports**: `ASK_BILL_CONGRESS_API_KEY` and `ASK_BILL_ALLOW_OFFICIAL_IMPORTS=true` (extraction also needs the paid, sandbox-verified worker).

## Continue from evidence

Re-query main, open PRs and exact-head CI. Remaining no-input work: backup/restore drill scripts (AB-104), operator runbook (AB-108), accessibility/browser matrix (AB-099), character runtime renderer/mixer with static fallbacks (AB-063/064/070/077), alert delivery and worker diagnostics (AB-103). Production character mesh, rig, textures and animation (AB-048–AB-062) need an artist or paid Meshy credits. Never infer operational acceptance from merges.
