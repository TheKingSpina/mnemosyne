#!/bin/sh
set -eu

if [ -n "${MNEMOSYNE_BACKUP_ENV_FILE:-}" ]; then
  set -a
  . "${MNEMOSYNE_BACKUP_ENV_FILE}"
  set +a
fi

# `docker compose` interpolates every service in compose.yaml, not only postgres,
# so the child process needs the deployment values or the exec fails on unrelated
# services. compose.yaml requires NEO4J_PASSWORD, POSTGRES_PASSWORD,
# MNEMOSYNE_FORGET_SECRET, MNEMOSYNE_OWNER_TOKEN, and MNEMOSYNE_HARNESS_TOKEN, so
# all of them stay in the environment for the duration of the run. The provider
# key is not required and is dropped.
if [ -n "${MNEMOSYNE_DEPLOY_ENV_FILE:-}" ]; then
  set -a
  . "${MNEMOSYNE_DEPLOY_ENV_FILE}"
  set +a
  unset OPENROUTER_API_KEY
fi

: "${MNEMOSYNE_REPO:?MNEMOSYNE_REPO is required}"
: "${MNEMOSYNE_BACKUP_DIR:?MNEMOSYNE_BACKUP_DIR is required}"
: "${MNEMOSYNE_BACKUP_PASSPHRASE_FILE:?MNEMOSYNE_BACKUP_PASSPHRASE_FILE is required}"

output="${MNEMOSYNE_BACKUP_DIR}/mnemosyne-$(date -u +%Y%m%dT%H%M%SZ).dump"
exec npm --prefix "${MNEMOSYNE_REPO}" run backup:postgres -- \
  --output "${output}" \
  --verify-restore \
  --encrypt \
  --passphrase-file "${MNEMOSYNE_BACKUP_PASSPHRASE_FILE}" \
  --keep-last "${MNEMOSYNE_BACKUP_KEEP_LAST:-14}" \
  --keep-days "${MNEMOSYNE_BACKUP_KEEP_DAYS:-30}"
