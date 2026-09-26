# Host keep-alive

These templates keep a Mnemosyne deployment reachable on a Mac mini: they start the container runtime and reconcile the Compose project at login, and they periodically probe the API and the dashboard, repairing the stack after consecutive failures. They are intentionally not installed automatically.

`docker compose` services already carry `restart: unless-stopped`, so this layer covers what the Docker daemon itself cannot: a runtime that never started, or a project left behind by a crash.

## Scripts

| File                          | Role                                                                                                                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `mnemosyne-ensure-runtime.sh` | Starts the runtime when its socket is missing, waits for it, then runs `docker compose up -d --remove-orphans`.                                                                |
| `mnemosyne-healthcheck.sh`    | Probes the API readiness endpoint and the dashboard every cycle. After `MNEMOSYNE_FAILURE_THRESHOLD` consecutive failures it calls the ensure script, then resets its counter. |

Both scripts are idempotent and log one line per action to stdout, which launchd redirects to `__LOG_DIR__`.

## Environment variables

```text
MNEMOSYNE_REPO=/absolute/path/to/mnemosyne
MNEMOSYNE_DOCKER_SOCKET=/absolute/path/to/docker.sock
MNEMOSYNE_RUNTIME_APP=/Applications/OrbStack.app
MNEMOSYNE_API_HEALTH_URL=http://127.0.0.1:3000/health/ready
MNEMOSYNE_WEB_HEALTH_URL=http://127.0.0.1:18080/
```

Optional: `MNEMOSYNE_RUNTIME_WAIT_SECONDS` (default `180`), `MNEMOSYNE_PROBE_TIMEOUT_SECONDS` (default `10`), `MNEMOSYNE_FAILURE_THRESHOLD` (default `2`), `MNEMOSYNE_STATE_DIR` (default `~/.mnemosyne`).

The runtime is started with `open -g -a`, so the mini must be logged in. Confirm the runtime also has its own "start at login" option enabled; the launchd job is the safety net, not the replacement.

## macOS launchd install

Render both templates, then bootstrap them:

```bash
REPO="$HOME/Mnemosyne"
SOCKET="$HOME/.orbstack/run/docker.sock"
LOG_DIR="$HOME/Library/Logs/mnemosyne"
mkdir -p "$LOG_DIR"
for tpl in com.mnemosyne.runtime com.mnemosyne.health; do
  sed -e "s|__REPO__|$REPO|g" \
      -e "s|__DOCKER_SOCKET__|$SOCKET|g" \
      -e "s|__RUNTIME_APP__|/Applications/OrbStack.app|g" \
      -e "s|__API_HEALTH_URL__|http://127.0.0.1:3000/health/ready|g" \
      -e "s|__WEB_HEALTH_URL__|http://127.0.0.1:18080/|g" \
      -e "s|__LOG_DIR__|$LOG_DIR|g" \
      "$REPO/ops/host/launchd/$tpl.plist" > "$HOME/Library/LaunchAgents/$tpl.plist"
  plutil -lint "$HOME/Library/LaunchAgents/$tpl.plist"
  launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/$tpl.plist"
done
```

Inspect with `launchctl print gui/$(id -u)/com.mnemosyne.health` and read `~/Library/Logs/mnemosyne/`. Reload after an edit with `launchctl bootout` followed by `launchctl bootstrap`.

A login item is not enough on its own: it only runs when a user session starts. Pair it with the backup schedule in [`../backup`](../backup/README.md) and confirm the whole chain with a reboot.
