#!/bin/sh
set -eu

# Idempotently makes the Mnemosyne stack reachable again: starts the container
# runtime when it is not answering, then reconciles the Compose project.
# Safe to run from launchd at login and from the periodic health check.
#
# The runtime can leave a stale socket behind with no daemon behind it, so the
# socket file is never treated as proof of a working runtime. Every docker call
# is bounded: a wedged daemon must fail fast and be restarted, not hang the job.

PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export PATH

: "${MNEMOSYNE_REPO:?MNEMOSYNE_REPO is required}"
: "${MNEMOSYNE_DOCKER_SOCKET:?MNEMOSYNE_DOCKER_SOCKET is required}"
: "${MNEMOSYNE_RUNTIME_APP:?MNEMOSYNE_RUNTIME_APP is required}"
: "${MNEMOSYNE_RUNTIME_WAIT_SECONDS:=300}"
: "${MNEMOSYNE_DOCKER_PROBE_SECONDS:=20}"
: "${MNEMOSYNE_RUNTIME_PROCESS:=OrbStack}"

log() {
  printf '%s ensure-runtime %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

# Runs a command with a hard limit, so a hung daemon cannot block launchd.
run_bounded() {
  limit="$1"
  shift
  "$@" &
  command_pid=$!
  (sleep "${limit}"; kill -9 "${command_pid}" 2>/dev/null) &
  watchdog_pid=$!
  set +e
  wait "${command_pid}"
  status=$?
  set -e
  kill "${watchdog_pid}" 2>/dev/null
  wait "${watchdog_pid}" 2>/dev/null || true
  return "${status}"
}

daemon_answers() {
  run_bounded "${MNEMOSYNE_DOCKER_PROBE_SECONDS}" \
    docker version --format '{{.Server.Version}}' >/dev/null 2>&1
}

# The app can be running with its virtual machine down. Only after the daemon has
# stayed silent across consecutive probes is the app recycled, and at most once
# per run, so a single bad probe cannot start a restart loop.
restart_runtime_app() {
  log "runtime silente: riciclo ${MNEMOSYNE_RUNTIME_PROCESS}"
  pkill -x "${MNEMOSYNE_RUNTIME_PROCESS}" 2>/dev/null || true
  sleep 5
  log "avvio ${MNEMOSYNE_RUNTIME_APP}"
  open -g -a "${MNEMOSYNE_RUNTIME_APP}" || log "open ha restituito $?"
  recycled=1
}

wait_for_daemon() {
  waited=0
  misses=0
  while [ "${waited}" -lt "${MNEMOSYNE_RUNTIME_WAIT_SECONDS}" ]; do
    if daemon_answers; then
      log "daemon pronto dopo ${waited}s"
      return 0
    fi
    misses=$((misses + 1))
    if [ "${misses}" -ge 3 ] && [ "${recycled}" -eq 0 ] &&
      pgrep -x "${MNEMOSYNE_RUNTIME_PROCESS}" >/dev/null 2>&1; then
      restart_runtime_app
      misses=0
    fi
    sleep 10
    waited=$((waited + 10))
  done
  return 1
}

cd "${MNEMOSYNE_REPO}"

if [ ! -d "${MNEMOSYNE_RUNTIME_APP}" ]; then
  log "runtime non trovato in ${MNEMOSYNE_RUNTIME_APP}"
  exit 1
fi

recycled=0
export DOCKER_HOST="unix://${MNEMOSYNE_DOCKER_SOCKET}"

if daemon_answers; then
  log "daemon già pronto"
else
  if ! pgrep -x "${MNEMOSYNE_RUNTIME_PROCESS}" >/dev/null 2>&1; then
    log "avvio ${MNEMOSYNE_RUNTIME_APP}"
    open -g -a "${MNEMOSYNE_RUNTIME_APP}" || log "open ha restituito $?"
  fi
  if ! wait_for_daemon; then
    log "daemon non disponibile dopo ${MNEMOSYNE_RUNTIME_WAIT_SECONDS}s"
    exit 1
  fi
fi

log "compose up -d"
if run_bounded "${MNEMOSYNE_DOCKER_PROBE_SECONDS}" docker compose up -d --remove-orphans; then
  log "stack riconciliato"
else
  log "compose up fallito"
  exit 1
fi
