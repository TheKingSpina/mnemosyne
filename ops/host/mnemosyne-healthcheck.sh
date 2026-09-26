#!/bin/sh
set -eu

# Periodic guard for the Mnemosyne stack: probes the API readiness endpoint and
# the dashboard, and asks ensure-runtime to reconcile the stack when a probe
# fails. Consecutive failures are required before a repair attempt so a single
# slow response does not trigger a restart.

PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export PATH

: "${MNEMOSYNE_REPO:?MNEMOSYNE_REPO is required}"
: "${MNEMOSYNE_DOCKER_SOCKET:?MNEMOSYNE_DOCKER_SOCKET is required}"
: "${MNEMOSYNE_RUNTIME_APP:?MNEMOSYNE_RUNTIME_APP is required}"
: "${MNEMOSYNE_API_HEALTH_URL:=http://127.0.0.1:3000/health/ready}"
: "${MNEMOSYNE_WEB_HEALTH_URL:=http://127.0.0.1:18080/}"
: "${MNEMOSYNE_PROBE_TIMEOUT_SECONDS:=10}"
: "${MNEMOSYNE_FAILURE_THRESHOLD:=2}"
: "${MNEMOSYNE_STATE_DIR:=${HOME}/.mnemosyne}"

mkdir -p "${MNEMOSYNE_STATE_DIR}"
state_file="${MNEMOSYNE_STATE_DIR}/healthcheck.failures"

log() {
  printf '%s healthcheck %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

probe() {
  curl -fsS --max-time "${MNEMOSYNE_PROBE_TIMEOUT_SECONDS}" -o /dev/null "$1"
}

failures=0
[ -f "${state_file}" ] && failures=$(cat "${state_file}" 2>/dev/null || echo 0)
case "${failures}" in
  '' | *[!0-9]*) failures=0 ;;
esac

api_ok=0
web_ok=0
probe "${MNEMOSYNE_API_HEALTH_URL}" && api_ok=1
probe "${MNEMOSYNE_WEB_HEALTH_URL}" && web_ok=1

if [ "${api_ok}" -eq 1 ] && [ "${web_ok}" -eq 1 ]; then
  if [ "${failures}" -ne 0 ]; then
    log "recuperato dopo ${failures} fallimenti consecutivi"
  fi
  rm -f "${state_file}"
  exit 0
fi

failures=$((failures + 1))
printf '%s' "${failures}" >"${state_file}"
log "probe fallito (api=${api_ok} web=${web_ok}), fallimenti=${failures}"

if [ "${failures}" -lt "${MNEMOSYNE_FAILURE_THRESHOLD}" ]; then
  exit 1
fi

log "soglia raggiunta: riconcilio lo stack"
rm -f "${state_file}"
if MNEMOSYNE_REPO="${MNEMOSYNE_REPO}" \
  MNEMOSYNE_DOCKER_SOCKET="${MNEMOSYNE_DOCKER_SOCKET}" \
  MNEMOSYNE_RUNTIME_APP="${MNEMOSYNE_RUNTIME_APP}" \
  sh "${MNEMOSYNE_REPO}/ops/host/mnemosyne-ensure-runtime.sh"; then
  log "riconcilio completato"
  exit 0
fi

log "riconcilio fallito"
exit 1
