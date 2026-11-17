#!/bin/sh
# Hosted web entrypoint for hosts without a separate pre-deploy step (for example a free web plan).
#
# When the owner-only maintenance values are present, apply migrations and the idempotent publisher
# bootstrap as separate short-lived processes, then start the public web process with every owner
# value removed from its environment. The web process always connects with the restricted runtime
# role in ASK_BILL_DATABASE_URL and refuses to start if that role can own, migrate or enroll.
#
# Operators remove ASK_BILL_MIGRATION_DATABASE_URL and ASK_BILL_RUNTIME_DB_PASSWORD from the service
# after the first successful deploy; later deploys then skip maintenance entirely.
set -eu
cd "$(dirname "$0")/.."

if [ -n "${ASK_BILL_MIGRATION_DATABASE_URL:-}" ]; then
  node scripts/migrate.mjs
  if [ -n "${ASK_BILL_OWNER_USER_ID:-}" ]; then
    node scripts/bootstrap-publisher.mjs
  fi
  if [ -n "${ASK_BILL_OWNER_INVITE_DIGEST:-}" ]; then
    node scripts/create-owner-invite.mjs
  fi
  node scripts/migrate.mjs --check
fi

exec env \
  -u ASK_BILL_MIGRATION_DATABASE_URL \
  -u ASK_BILL_RUNTIME_DB_PASSWORD \
  -u ASK_BILL_RUNTIME_DB_ROLE \
  -u ASK_BILL_OWNER_USER_ID \
  -u ASK_BILL_OWNER_OIDC_SUBJECT \
  -u ASK_BILL_OWNER_IDENTITY \
  -u ASK_BILL_PUBLISHER_SLUG \
  -u ASK_BILL_PUBLISHER_NAME \
  -u ASK_BILL_OWNER_INVITE_DIGEST \
  -u ASK_BILL_OWNER_INVITE_TTL_HOURS \
  node apps/web/application/start.mjs
