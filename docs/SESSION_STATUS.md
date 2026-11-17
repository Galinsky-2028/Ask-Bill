# Ask Bill — verified development checkpoint

GitHub observation: **2026-11-15T19:07Z**, repository `Galinsky-2028/Ask-Bill` (formerly `neophilism/Ask-Bill`), main `0f6025a5` (live on Render).

## Merged in this session (all five required jobs green on each exact head)

| PR | Unit | Result |
| --- | --- | --- |
| #109 | AB-001 | Registry bound to `Galinsky-2028/Ask-Bill` (the old identity failed every PR's quality job); browser CI job pinned to `ubuntu-24.04` (Playwright 1.57 rejects 26.04) |
| #108 | AB-105 (partial) | `ASK_BILL_OWNER_IDENTITY=deferred` bootstrap; `infra/start-web.sh` runs owner-only maintenance in separate processes, then starts web without owner values |
| #106 | AB-094 (partial) | Publisher tour/translation drafts, readiness classifier, failed-import retry; migrations 010/011 |
| #110 | AB-103 (partial) | Aggregate privacy-minimized telemetry, token-gated `/health/metrics`, `infra/alerts/rules.json` |
| #111 | AB-102 (partial) | Spend-safe reader load harness and local baseline |

| #113 | AB-065 | De-flaked the scroll-invalidation browser check (it now waits for the scroll event) |
| #114 | AB-104 (partial) | Restore fingerprint, Neon PITR drill (live drill 3.4 s, branch deleted), `docs/ops/RECOVERY.md` |
| #115 | AB-099 (partial) | axe WCAG 2.2 AA + keyboard audit; CI matrix Chromium/Firefox/WebKit; `docs/accessibility/AUDIT.md` |
| #116 | AB-103 (partial) | Queue/outbox/retention diagnostics, webhook alert delivery, 6-hourly `ops-alerts` workflow |
| #117 | AB-108 (partial) | `docs/ops/OPERATOR_RUNBOOK.md` with a path-verification test |
| #118 | AB-063/064/070/077 (partial) | Optional candidate 3D stage (off by default), clip controller, version-safe pointing, contained fallbacks |
| #122 | AB-076 | Performance recorder, redacted traces, deterministic replay |
| #123, #124 | AB-008 (+009/014/105) | Zero-account publishing: passkeys, PostgreSQL private storage, text/Markdown embedded extraction; fixed admin `Origin: null` form defect |
| #120 | AB-063 (+064/072/060 runtime/083/103) | WebGPU with WebGL 2 fallback, blink/gaze/viseme layers, sticky follow and gutter dock, golden-pose and backend-parity regression, source-freshness alert |

Draft PR #105 (AB-048 character topology) remains open and untouched. No art unit (AB-045–AB-062) is claimed. The browser job's scroll-invalidation check (`test_layout_anchor_registry.py`) failed once on #111 and passed on rerun; treat it as flaky.

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

Re-query main, open PRs and exact-head CI. Remaining work is now mostly blocked on inputs: production character art (AB-045 to AB-062: mesh, rig with a head/eye skeleton, textures, approved clips), live providers (AI, voice with aligned viseme timing, OIDC, storage, Congress API), a reviewed authoritative corpus, a domain, and the paid worker. Software-only follow-ups: contact-aware walking across the page (AB-069; needs a rig with foot bones), a performance replay recorder (AB-076), translation publication policy, and acceptance gates that require live evidence. Owner inputs: GitHub secret `ASK_BILL_METRICS_TOKEN` (same value as Render), optional `ASK_BILL_ALERT_WEBHOOK_URL`; set `ASK_BILL_CHARACTER_STAGE=true` on Render to preview the candidate stage.

## Publishing on staging (no external accounts)

Staging runs with `ASK_BILL_ALLOW_PUBLISHING=true`, `ASK_BILL_PUBLISHER_AUTH=passkey`, `ASK_BILL_STORAGE_DRIVER=postgres` and `ASK_BILL_EMBEDDED_TEXT_WORKER=true`. Migrations 012 and auth 003 are applied and the runtime role is re-granted. **No passkey is enrolled and no invite exists yet**, so nobody can sign in until the owner completes the enrolment steps in `docs/ops/APPLICATION_RUNTIME.md` ("Owner steps to enrol the first publisher passkey"). No bill content has been published; choosing it is the owner's decision. Uploads accept .txt and .md; PDF, Word and XML need the sandboxed worker.
