# Auto-recall hooks (PMB-style)

Mnemosyne composes context on demand via `memory_context` / `memory_search`. To
get **push-style** auto-recall (memory injected before the model reasons, like
PMB's hooks), wire a client hook that calls `ops/hooks/auto-recall.mjs`.

## Claude Code

Add to `~/.claude/settings.json` (or project `.claude/settings.json`):

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "MNEMOSYNE_API_URL=http://127.0.0.1:3000 MNEMOSYNE_OWNER_TOKEN=<token> node /path/to/mnemosyne/ops/hooks/auto-recall.mjs <projectId> \"$PROMPT\""
          }
        ]
      }
    ]
  }
}
```

The hook's stdout is appended to the prompt context. The script exits 0 and
prints nothing on failure, so it never breaks a turn.

## Cursor / Codex / Zed

Use the equivalent "before request" / "prompt submit" hook mechanism and invoke
the same script with the project id and the user message.

## Notes

- The helper opens a transient session per call; keep the budget small (default
  1200 tokens) to avoid bloating the prompt.
- For remote (Tailscale) use, point `MNEMOSYNE_API_URL` at the tailnet URL and
  use a per-client owner token.
- Auto-recall counts as "applied" for follow-rate tracking, since it goes
  through `memory_context` (resolveContext).
