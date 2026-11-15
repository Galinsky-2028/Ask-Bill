# Ask Bill operator runbook (AB-108)

Start here when operating or continuing Ask Bill. Every path and command below is checked by `tests/operator-runbook.test.mjs`.

## 1. Identify the exact build

- **Live service:** Render web service `ask-bill` (`srv-dbsvlm0ae00c7397us50`), <https://ask-bill.onrender.com>. `GET /health/ready` returns `{"status":"ready","build":"<git sha>"}`. The build is `RENDER_GIT_COMMIT`, read by `packages/config/runtime.mjs`.
- **From the API** (when the site is unreachable from your network): `GET https://api.render.com/v1/services/srv-dbsvlm0ae00c7397us50/deploys?limit=1` shows the commit and status. Logs: `GET /v1/logs?ownerId=<workspace>&resource=srv-dbsvlm0ae00c7397us50&limit=50`.
- **Database:** Neon project `winter-waterfall-73466147`. `node scripts/migrate.mjs --check` (owner URL) confirms the schema matches the checked-out commit.
- **Plan state:** `registry/prs.json` (only active plan), `docs/SESSION_STATUS.md` (dated checkpoint), `docs/HANDOFF.md`.

## 2. Reproduce checks locally

```sh
corepack enable && corepack pnpm install --frozen-lockfile   # Node 24.19.0 (.node-version)
corepack pnpm verify          # lint, typecheck, unit tests, registry, foundation check
corepack pnpm dev             # synthetic demo on http://127.0.0.1:4100
python tests/accessibility/test_axe_audit.py      # needs Playwright 1.57 + Chromium
bash tests/postgres/integration.sh                # needs Docker
node tools/perf/load.mjs --target http://127.0.0.1:4100 --paths /bills,/learn --requests 500
```

CI (`.github/workflows/ci.yml`) runs the quality, browser, accessibility (Chromium/Firefox/WebKit), database, PDF and container jobs. A merge needs every job green on the **exact** PR head (`docs/GITHUB_MERGE_PREFLIGHT.md`).

## 3. Release (merge → deploy → confirm)

1. PR title `AB-XXX: …`, evidence in `docs/evidence/AB-XXX.md` (template `docs/evidence/UNIT_TEMPLATE.md`).
2. Merge with the tested SHA: `gh api -X PUT repos/Galinsky-2028/Ask-Bill/pulls/<n>/merge -f merge_method=squash -f sha=<head sha>`.
3. Auto-deploy is **off**. Deploy that exact commit: `POST https://api.render.com/v1/services/srv-dbsvlm0ae00c7397us50/deploys` with body `{"commitId":"<merged sha>"}`.
4. Poll `GET …/deploys/<id>` until `live`. Render gates `live` on `/health/ready`. Then confirm `build` in `/health/ready` equals the merged SHA.
5. **Schema changes:** a PR adding migrations needs the one-time maintenance values on the service for that deploy. Set `ASK_BILL_MIGRATION_DATABASE_URL`, `ASK_BILL_OWNER_USER_ID`, `ASK_BILL_OWNER_IDENTITY=deferred` (or real OIDC values), `ASK_BILL_PUBLISHER_SLUG`, `ASK_BILL_PUBLISHER_NAME` and `ASK_BILL_RUNTIME_DB_ROLE`. `infra/start-web.sh` migrates, re-grants and then starts the web process without them. Delete them afterwards (`docs/ops/APPLICATION_RUNTIME.md`).
6. **Rollback:** deploy the previous good commit the same way. Migrations are additive, so older code runs on a newer schema.

## 4. Troubleshooting

Startup logs show one fixed line and never secret values. Common causes:

| Symptom | Cause / fix |
| --- | --- |
| `Ask Bill startup failed…` right after deploy | Config validation failed. Codes in `packages/config/runtime.mjs` (`INVALID_SESSION_ENCRYPTION_KEY`: must be 32 bytes base64; `INVALID_PUBLIC_ORIGIN`: exact https origin without a slash; `PROVIDER_DATA_PROTECTION_REQUIRED`: a provider flag is on without `ASK_BILL_PROVIDER_DATA_PROTECTION=verified`; `INDEPENDENT_REVIEW_MODEL_REQUIRED`: the LLM and review models must differ). |
| Startup fails with a database error | `DATABASE_READINESS_FAILED`: the runtime role is unreachable or too privileged (it must not own, create or bypass RLS). `PUBLISHER_NOT_BOOTSTRAPPED`: run bootstrap. Missing tables: run migrations (section 3.5). |
| `Ask Bill migration failed` / `bootstrap failed` | Owner URL wrong, migration hash history mismatch (never edit an applied migration), or an existing publisher/identity differs (bootstrap never overwrites). |
| `/health/ready` 503 | Database unreachable (Neon compute suspended or limit reached), or the service is draining. |
| First request slow | Free Render plan sleeps when idle, and the Neon free compute auto-suspends. Expect a cold start. |
| Publisher pages 404 | `ASK_BILL_ALLOW_PUBLISHING=false` or a non-https origin; see `docs/SESSION_STATUS.md` for the enabling steps. |
| Metrics 404 | `ASK_BILL_METRICS_TOKEN` is unset or wrong bearer value (`packages/telemetry/index.mjs`). |

Alerts: `infra/alerts/rules.json`, evaluated by `scripts/ops/check-alerts.mjs` when present, or by any scraper of `/health/metrics`.

## 5. Recovery and rotation

See `docs/ops/RECOVERY.md`: point-in-time restore drill (`scripts/recovery/neon-restore-drill.mjs`), content fingerprint (`scripts/recovery/fingerprint.mjs`), credential rotation and lost-asset handling.

## 6. Sources and content updates

Publisher workflow: create bill → upload or official import → review six checks → publish immutable release → correct or withdraw (`docs/ops/APPLICATION_RUNTIME.md`, `docs/ops/content/`). Official imports need `ASK_BILL_CONGRESS_API_KEY` and the sandbox-verified worker (`docs/ops/WORKER_QUEUE.md`, `docs/ops/INTAKE_SANDBOX.md`, `infra/render-worker.yaml`, a paid plan). Never edit published canonical text; publish a correction.

## 7. Providers (replace or add)

Adapters live in `packages/providers/` and are documented in `docs/ops/openai-provider-adapters.md`. Replacement must keep structured output, independent review, cancellation and data-protection gating. Keys are Render env vars only. Each feature is off unless its `ASK_BILL_ALLOW_*` flag is `true`.

## 8. Character rebuild

- Contract: `docs/CHARACTER_PRODUCTION.md`, design `assets/bill/design/OPTION_10_APPROVED.md`, clips `docs/character/ANIMATION_LIBRARY.md`.
- Candidate GLBs: `assets/bill/characters/dist/` (candidates, **not** the approved production asset).
- Blender tooling: `tools/blender/generate_bill.py`, `tools/blender/import_candidate_to_blend.py`, `tools/blender/verify_candidate_blend.py`. Meshy animation import: `tools/meshy/fetch_bill_animations.py`, `tools/meshy/merge_bill_animations.py` (paid credits, GitHub secret `MESHY_API_KEY`), `docs/character/MESHY_API_INTEGRATION.md`.
- Asset validation: `node tools/assets/verify.mjs` (`assets/manifest.json`).

## 9. Selecting the next work

`node scripts/ready-work.mjs` lists dependency-ready units from the registry. Verify each against live GitHub PRs and CI before starting. Map only genuine PR numbers. Record partial work honestly, and never mark operational acceptance from a merge.
