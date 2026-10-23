#!/usr/bin/env node
// Auto-recall helper for Mnemosyne.
//
// Prints a compact context block for a given project + query, so it can be
// injected into an agent prompt by a client hook (Claude Code UserPromptSubmit,
// Cursor, etc.). Reads MNEMOSYNE_API_URL and MNEMOSYNE_OWNER_TOKEN (or
// MNEMOSYNE_HARNESS_TOKEN) from the environment. Opens a transient session on
// the project, resolves the context, closes the session, and prints the result
// as JSON on stdout. On any failure it prints nothing and exits 0, so a hook
// never breaks the agent turn.
//
// Usage:
//   MNEMOSYNE_API_URL=http://127.0.0.1:3000 \\
//   MNEMOSYNE_OWNER_TOKEN=... \\
//   node ops/hooks/auto-recall.mjs <projectId> "<query>" [budgetTokens]
import { randomUUID } from 'node:crypto';

const apiUrl = (process.env.MNEMOSYNE_API_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const token = process.env.MNEMOSYNE_OWNER_TOKEN || process.env.MNEMOSYNE_HARNESS_TOKEN;
const projectId = process.argv[2];
const query = process.argv[3] || '';
const budget = Number(process.argv[4] || 1200);

if (!token || !projectId || !query) process.exit(0);

const headers = {
  authorization: `Bearer ${token}`,
  'content-type': 'application/json',
};

async function main() {
  // Open a transient session on the project.
  const openRes = await fetch(`${apiUrl}/v1/sessions`, {
    method: 'POST',
    headers: { ...headers, 'idempotency-key': randomUUID() },
    body: JSON.stringify({ projectId, taskTitle: 'auto-recall' }),
  });
  if (!openRes.ok) return;
  const { sessionId } = await openRes.json();

  try {
    const ctxRes = await fetch(`${apiUrl}/v1/context/resolve`, {
      method: 'POST',
      headers: { ...headers, 'idempotency-key': randomUUID() },
      body: JSON.stringify({ sessionId, query, budgetTokens: budget }),
    });
    if (!ctxRes.ok) return;
    const ctx = await ctxRes.json();
    const lines = (ctx.context || []).map(
      (m) =>
        `- [${m.memoryId} v${m.version}] (${m.kind}, ${m.scope.type}:${m.scope.id}) ${m.content}`,
    );
    if (lines.length === 0) return;
    process.stdout.write(
      JSON.stringify({
        projectId,
        query,
        memories: ctx.context.length,
        tokensEstimated: ctx.tokensEstimated,
        block: `Mnemosyne auto-recall (${ctx.context.length} memorie, ~${ctx.tokensEstimated} token):\n${lines.join('\n')}`,
      }),
    );
  } finally {
    try {
      await fetch(`${apiUrl}/v1/sessions/${encodeURIComponent(sessionId)}/close`, {
        method: 'POST',
        headers: { ...headers, 'idempotency-key': randomUUID() },
        body: JSON.stringify({}),
      });
    } catch {
      // ignore
    }
  }
}

main().catch(() => process.exit(0));
