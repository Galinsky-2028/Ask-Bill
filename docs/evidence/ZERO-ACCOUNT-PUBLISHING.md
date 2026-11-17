# Zero-account publishing: passkeys, PostgreSQL storage and text-only extraction

Contributes to **AB-008** (publisher authentication and MFA), **AB-009** (private object storage), **AB-014** (upload quarantine and extraction containment) and **AB-105** (service configuration). Approved by the owner's direction to make publishing possible without external accounts. OIDC and S3 remain supported and unchanged.

## Paths
- `packages/auth/webauthn.mjs`: CBOR/COSE parsing, registration and assertion verification (challenge, origin, rpIdHash, user presence **and** verification, signature, counter), ES256, EdDSA and RS256.
- `packages/auth/passkey.mjs`, `packages/auth/passkey-store.mjs`: passkey auth with the same interface and session model as OIDC; invite-only enrolment; PostgreSQL ceremonies and credentials.
- `packages/auth/migrations/003_passkeys.sql`: invites, passkeys, single-use challenges (FORCE RLS) and `ask_bill.redeem_publisher_invite` (`SECURITY DEFINER`, atomic, audited).
- `migrations/012_private_objects.sql`, `packages/storage/postgres.mjs`: content-addressed private objects with immutability trigger, quota and per-read digest verification.
- `packages/db/publisher-source-extraction.mjs` (`textOnlyProcessBoundary`), `apps/worker/application.mjs` (`textOnly`), `apps/web/application/start.mjs`: embedded text-only job loop.
- `scripts/new-publisher-invite.mjs` (owner's computer), `scripts/create-owner-invite.mjs` (owner connection, run by `infra/start-web.sh`), bootstrap grants and the extended runtime-role safety check in `packages/db/pool.mjs`.
- Admin: passkey pages and same-origin script, JSON ceremony endpoints, CSP `script-src 'self'; connect-src 'self'`, and upload format limits.

## Defect fixed
Admin pages sent `Referrer-Policy: no-referrer`. Under the Fetch standard, browsers then send `Origin: null` on form POSTs, so every publisher form action (sign out, create bill, upload, review, publish) would have failed the origin check in a real browser. The existing browser test only used GETs. The policy is now `same-origin`, which still never reveals a referrer to other sites. The passkey browser test exercises a real form POST.

## Tests
- `tests/passkey.test.mjs` (10): real ES256/EdDSA/RS256 keys from a software authenticator. Covers wrong challenge, origin or rpId, missing UV, tampered signature, counter regression, a foreign key, malformed CBOR, invite format, the full enrol → MFA session → sign-in → replay-rejection flow, and configuration refusal.
- `tests/zero-account-publishing.test.mjs` (3): config without external accounts; the text-only extractor parses text in a permission-limited process and refuses PDF; admin JSON endpoints over HTTP (origin rejection, invalid invite, CSP, single-use challenge).
- `tests/postgres/passkeys_storage.mjs` (4, CI database job), run locally on PostgreSQL 16 with a superuser owner and with a non-superuser (Neon-like) owner:
  - the owner CLI stores only the digest;
  - the runtime role cannot insert invites, identities or passkeys (42501);
  - enrolment through the runtime role redeems once and the clone counter is enforced;
  - storage digests, quota, source immutability (23514), no runtime UPDATE, and tenant isolation.
- `tests/browser/test_passkey_browser.py` (CI browser job), in Chromium with a CDP virtual authenticator: enrol with an invite, reach the desk with MFA, sign out (form POST), sign in with the passkey, invite reuse refused, and no session from an authenticator without user verification.
- `tests/container/smoke.mjs`: text-only extraction under the permission model inside the built image.

## Boundaries
- The text-only process boundary is not the OS sandbox: it is used only for our own pure-JS text/Markdown parsers. Binary and XML formats still require `infra/render-worker.yaml` and the sandbox probe.
- No passkey was enrolled by the agent, and no invite code was generated, stored or transmitted by the agent. No bill content was published.
