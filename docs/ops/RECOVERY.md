# Backup, restore and incident drills (AB-104)

## What is backed up

| Data | Where | Backup |
| --- | --- | --- |
| Publishers, bills, immutable versions, provisions, reviews, releases, search, audit, jobs | Neon project `winter-waterfall-73466147` (`Ask Bill`), database `neondb` | Neon point-in-time restore (history window depends on the Neon plan; free plan is short, so take a logical dump before risky changes) |
| Private originals (uploads, official imports) | S3-compatible bucket (not configured yet) | Enable bucket versioning and object lock/retention at the provider; `source_objects.sha256` and `storage_key` let every object be re-verified |
| Anonymous sessions, encrypted answers, login transactions | Same database | **Not** restored on purpose; short-lived and invalidated by key rotation |
| Code, migrations, infra | GitHub `Galinsky-2028/Ask-Bill` | Git history; deploy any prior commit |

Initial objectives (staging): **RPO** ≤ 24 h for durable publishing data (point-in-time restore is finer), **RTO** ≤ 1 h to a verified, serving restore.

## Restore drill (isolated, repeatable)

1. Fingerprint production (owner URL only on an operator machine, never on a service):
   `ASK_BILL_MIGRATION_DATABASE_URL=<owner url> ASK_BILL_PUBLISHER_ID=<publisher> node scripts/recovery/fingerprint.mjs > before.json`
2. Create an isolated point-in-time branch and keep it:
   `NEON_API_KEY=<key> node scripts/recovery/neon-restore-drill.mjs --project winter-waterfall-73466147 --at <ISO time> --keep`
   (From a proxied sandbox add `NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=<ca bundle>`.)
3. Fingerprint the branch with its owner URL from the Neon console → `after.json`, then
   `node scripts/recovery/fingerprint.mjs --compare before.json after.json` (exit 2 lists differences: durable row counts, source/release/audit digests, migration journal, tables missing forced RLS).
4. Delete the drill branch in the Neon console (or rerun the drill without `--keep`).

The fingerprint prints only counts and SHA-256 digests: no source text, drafts, questions or secrets.

## Real recovery

1. Disable writes: set `ASK_BILL_ALLOW_PUBLISHING=false` (reading continues).
2. Restore: in Neon, restore the `main` branch to the chosen timestamp (Neon keeps the pre-restore state as a backup branch), or promote a verified drill branch.
3. Run `node scripts/migrate.mjs --check` and the fingerprint comparison against the last good fingerprint.
4. Redeploy the matching commit on Render, confirm the deploy is `live` (health-check gated) and re-enable publishing.

## Credential rotation

- **Runtime DB password** (suspected leak): with the owner URL, `ALTER ROLE ask_bill_runtime PASSWORD '<new 48+ chars>'`; update `ASK_BILL_DATABASE_URL` on Render; redeploy. Old connections fail at next connect.
- **Owner password**: reset in the Neon console (Roles → reset password). It is never stored on a service.
- **Session encryption key**: replace `ASK_BILL_SESSION_ENCRYPTION_KEY` (32 random bytes, base64) and redeploy. Existing answer replays become unreadable by design; reading is unaffected.
- **Metrics token / provider keys / OIDC secret**: replace the Render env var and redeploy; revoke the old value at the provider.
- **Publisher identity compromise**: disable the identity row (`publisher_auth_identities.disabled_at`) as owner, revoke at the identity provider, then enroll the replacement with `db:bootstrap`.

## Lost asset pointer

If an object in storage is missing or altered, `assertMatchingStoredObject` refuses to serve it and the version stays unpublishable. Re-upload the original. The upload path verifies `sha256` against `source_objects`, so only the exact original bytes reattach. Never edit `source_objects` hashes.

## Drill log

| Date (UTC) | Drill | Result |
| --- | --- | --- |
| 2026-11-15 | Neon PITR branch of `winter-waterfall-73466147` at T−5 min, created and deleted by `neon-restore-drill.mjs` | Branch compute ready in 3.4 s, total 6.1 s, deleted; only `main` remains. Fingerprint comparison **not run** from the drill sandbox (no Postgres TCP egress); run step 3 from an operator machine. |
