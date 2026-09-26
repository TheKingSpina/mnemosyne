#!/bin/sh
set -eu

# Idempotently makes the Mnemosyne stack reachable again: starts the container
# runtime when its socket is missing, then reconciles the Compose project.
# Safe to run from launchd at login and from the periodic health check.

PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export PATH

: "${MNEMOSYNE_REPO:?MNEMOSYNE_REPO is required}"
: "${MNEMOSYNE_DOCKER_SOCKET:?MNEMOSYNE_DOCKER_SOCKET is required}"
: "${MNEMOSYNE_RUNTIME_APP:?MNEMOSYNE_RUNTIME_APP is required}"
: "${MNEMOSYNE_RUNTIME_WAIT_SECONDS:=180}"

log() {
  printf '%s ensure-runtime %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

runtime_socket_ready() {
  [ -S "${MNEMOSYNE_DOCKER_SOCKET}" ]
}

wait_for_socket() {
  waited=0
  while [ "${waited}" -lt "${MNEMOSYNE_RUNTIME_WAIT_SECONDS}" ]; do
    if runtime_socket_ready; then
      return 0
    fi
    sleep 5
    waited=$((waited + 5))
  done
  return 1
}

cd "${MNEMOSYNE_REPO}"

if ! runtime_socket_ready; then
  log "socket assente: avvio ${MNEMOSYNE_RUNTIME_APP}"
  if [ ! -d "${MNEMOSYNE_RUNTIME_APP}" ]; then
    log "runtime non trovato in ${MNEMOSYNE_RUNTIME_APP}"
    exit 1
  fi
  open -g -a "${MNEMOSYNE_RUNTIME_APP}" || log "open runtime ha restituito $?"
  if ! wait_for_socket; then
    log "socket non disponibile dopo ${MNEMOSYNE_RUNTIME_WAIT_SECONDS}s"
    exit 1
  fi
  log "socket pronto"
else
  log "socket già pronto"
fi

if ! docker info >/dev/null 2>&1; then
  log "docker info non risponde"
  exit 1
fi

log "compose up -d"
if docker compose up -d --remove-orphans; then
  log "stack riconciliato"
else
  log "compose up fallito"
  exit 1
fi
