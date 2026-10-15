#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import process from 'node:process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, URLSearchParams } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const composeFile = resolve(root, 'compose.yaml');
const project = `mnemosyne-e2e-${process.pid}-${Date.now()}`;
const ports = {
  api: await availablePort(),
  postgres: await availablePort(),
  redis: await availablePort(),
  neo4j: await availablePort(),
};
const ownerToken = `owner-${randomBytes(24).toString('hex')}`;
const harnessToken = `harness-${randomBytes(24).toString('hex')}`;
const forgetSecret = `forget-${randomBytes(24).toString('hex')}`;
const postgresPassword = `postgres-${randomBytes(24).toString('hex')}`;
const neo4jPassword = `neo4j-${randomBytes(24).toString('hex')}`;
const inheritedEnvironment = { ...process.env };
for (const key of Object.keys(inheritedEnvironment)) {
  if (
    /^(OPENROUTER_|MNEMOSYNE_|DATABASE_URL$|POSTGRES_|NEO4J_|REDIS_|API_|WORKER_|COMPOSE_)/u.test(
      key,
    )
  ) {
    delete inheritedEnvironment[key];
  }
}
// Schema-level constraints live in the database, and there is no API to reach
// them yet, so they are asserted over psql against the same PostgreSQL the rest
// of this script exercises. Unit tests cover the same rules in the in-memory
// repository; this is what proves the real schema matches.
const e2eDbUser = 'mnemosyne_e2e';
const e2eDbName = 'mnemosyne_e2e';

const environment = {
  ...inheritedEnvironment,
  COMPOSE_PROJECT_NAME: project,
  POSTGRES_DB: 'mnemosyne_e2e',
  POSTGRES_USER: 'mnemosyne_e2e',
  POSTGRES_PASSWORD: postgresPassword,
  POSTGRES_PORT: String(ports.postgres),
  REDIS_PORT: String(ports.redis),
  NEO4J_PORT: String(ports.neo4j),
  NEO4J_USERNAME: 'neo4j',
  NEO4J_PASSWORD: neo4jPassword,
  API_PORT: String(ports.api),
  MNEMOSYNE_OWNER_TOKEN: ownerToken,
  MNEMOSYNE_HARNESS_TOKEN: harnessToken,
  MNEMOSYNE_FORGET_SECRET: forgetSecret,
  EXTRACTION_PROVIDER: 'local',
  OPENROUTER_API_KEY: '',
  OPENROUTER_MODEL: '',
  WORKER_RETENTION_INTERVAL_MS: '60000',
  NEO4J_REBUILD_ON_START: 'false',
};
const apiUrl = `http://127.0.0.1:${ports.api}`;
let stackStarted = false;
let backupTempDirectory;

try {
  stackStarted = true;
  compose('up', '-d', '--build', 'postgres', 'redis', 'neo4j', 'api', 'worker');
  await waitForApi();
  await waitForGraph();
  const lifecycle = await runLifecycle();
  stackStarted = true;
  compose('down', '--volumes', '--remove-orphans');
  stackStarted = false;
  stackStarted = true;
  compose('up', '-d', '--build', 'api');
  await waitForApi();
  await restoreAndVerify(lifecycle);
  process.stdout.write('Synthetic end-to-end flow: OK\n');
} catch (error) {
  if (stackStarted) {
    try {
      process.stderr.write(collectServiceLogs());
    } catch {
      // The original failure is more useful than a diagnostic-log failure.
    }
  }
  process.stderr.write(`Synthetic end-to-end flow failed: ${errorMessage(error)}\n`);
  process.exitCode = 1;
} finally {
  if (stackStarted) {
    try {
      compose('down', '--volumes', '--remove-orphans');
    } catch {
      process.stderr.write('Synthetic end-to-end cleanup failed\n');
    }
  }
  if (backupTempDirectory) await rm(backupTempDirectory, { recursive: true, force: true });
}

async function runLifecycle() {
  // Areas are declared entities, so a session may only reference one that
  // exists. Declared over psql because there is no area endpoint yet; opening
  // the session provisions the project, but the area has to predate it.
  psql(
    "INSERT INTO projects (id, name) VALUES ('e2e-synthetic', 'E2E Synthetic') ON CONFLICT (id) DO NOTHING;",
  );
  psql(
    "INSERT INTO areas (id, project_id, name) VALUES ('e2e-area', 'e2e-synthetic', 'E2E Area') ON CONFLICT (id) DO NOTHING;",
  );
  const session = await api('/v1/sessions', {
    token: harnessToken,
    method: 'POST',
    key: 'e2e-open-session',
    body: { projectId: 'e2e-synthetic', areaIds: ['e2e-area'] },
    status: 201,
  });
  const firstEvent = await api(`/v1/sessions/${encodeURIComponent(session.sessionId)}/events`, {
    token: harnessToken,
    method: 'POST',
    key: 'e2e-first-event',
    body: {
      events: [
        {
          eventId: 'e2e-event-1',
          type: 'message',
          role: 'user',
          content: 'Ricorda che il progetto usa npm',
          occurredAt: '2026-01-20T10:00:00.000Z',
          explicitMemoryRequest: true,
        },
      ],
    },
    status: 202,
  });
  await waitForJob(firstEvent.jobIds[0]);
  const firstPending = await waitForPending(session.sessionId, 'il progetto usa npm');
  const first = await review(firstPending, 'e2e-review-first');
  const secondEvent = await api(`/v1/sessions/${encodeURIComponent(session.sessionId)}/events`, {
    token: harnessToken,
    method: 'POST',
    key: 'e2e-second-event',
    body: {
      events: [
        {
          eventId: 'e2e-event-2',
          type: 'message',
          role: 'user',
          content: 'Ricorda che il progetto non usa npm',
          occurredAt: '2026-01-20T10:01:00.000Z',
          explicitMemoryRequest: true,
        },
      ],
    },
    status: 202,
  });
  await waitForJob(secondEvent.jobIds[0]);
  const secondPending = await waitForPending(session.sessionId, 'il progetto non usa npm');
  const second = await review(secondPending, 'e2e-review-second');
  const thirdEvent = await api(`/v1/sessions/${encodeURIComponent(session.sessionId)}/events`, {
    token: harnessToken,
    method: 'POST',
    key: 'e2e-third-event',
    body: {
      events: [
        {
          eventId: 'e2e-event-3',
          type: 'message',
          role: 'user',
          content: "Ricorda che nell'area e2e-area il deploy usa docker",
          occurredAt: '2026-01-20T10:02:00.000Z',
          explicitMemoryRequest: true,
        },
      ],
    },
    status: 202,
  });
  await waitForJob(thirdEvent.jobIds[0]);
  const thirdPending = await waitForPending(
    session.sessionId,
    "nell'area e2e-area il deploy usa docker",
  );
  const third = await review(thirdPending, 'e2e-review-third');
  assert(third.memory.scope.type === 'area');
  assert(third.memory.scope.id === 'e2e-area');

  const context = await api('/v1/context/resolve', {
    token: harnessToken,
    method: 'POST',
    body: {
      sessionId: session.sessionId,
      query: 'npm',
      budgetTokens: 1_200,
    },
  });
  assert(context.context.some((memory) => memory.memoryId === first.memory.memoryId));
  const search = await api(
    `/v1/memories?${new URLSearchParams({
      sessionId: session.sessionId,
      q: 'non usa npm',
    })}`,
    { token: harnessToken },
  );
  assert(search.items.some((memory) => memory.memoryId === second.memory.memoryId));
  const feedback = await api('/v1/memories/feedback', {
    token: ownerToken,
    method: 'POST',
    key: 'e2e-feedback',
    body: {
      memoryId: first.memory.memoryId,
      sessionId: session.sessionId,
      kind: 'useful',
      observedAt: '2026-01-20T10:02:00.000Z',
    },
    status: 201,
  });
  assert(feedback.memoryId === first.memory.memoryId);
  const retention = await api('/v1/admin/retention/run', {
    token: ownerToken,
    method: 'POST',
    key: 'e2e-retention',
    body: {},
  });
  assert(retention.profile === 'balanced');
  await waitForGraphCount(3);
  // Projects and areas are graph roots, not labels: the worker projects them
  // as nodes, and every memory links to its project while area-scoped ones
  // additionally link to their area.
  await waitForGraphQuery(`MATCH (p:Project {id: 'e2e-synthetic'}) RETURN count(p);`, 1);
  await waitForGraphQuery(`MATCH (a:Area {id: 'e2e-area'}) RETURN count(a);`, 1);
  await waitForGraphQuery(
    `MATCH ()-[r:IN_PROJECT]->(:Project {id: 'e2e-synthetic'}) RETURN count(r);`,
    3,
  );
  await waitForGraphQuery(`MATCH ()-[r:IN_AREA]->(:Area {id: 'e2e-area'}) RETURN count(r);`, 1);
  const exported = await api('/v1/admin/exports/corpus', { token: ownerToken });
  assert(exported.forgetLedger.length === 0);
  assert(exported.memories.length === 3);
  assert(exported.conflicts.length === 1);

  await searchToCreateCache(session.sessionId, second.memory.memoryId);
  await verifyRuntimeCapabilities();
  await verifyProjectConstraints();
  await verifyMemoryProjectIdentity();
  await verifyArcConstraints();
  const prepared = await api(
    `/v1/memories/${encodeURIComponent(second.memory.memoryId)}/forget/prepare`,
    {
      token: ownerToken,
      method: 'POST',
      body: {},
    },
  );
  const forgotten = await api(`/v1/memories/${encodeURIComponent(second.memory.memoryId)}/forget`, {
    token: ownerToken,
    method: 'POST',
    key: 'e2e-forget-second',
    body: { confirmationToken: prepared.confirmationToken },
    status: 204,
  });
  assert(forgotten === null);
  await waitForRedisEmpty();
  const afterForget = await api(
    `/v1/memories?${new URLSearchParams({
      sessionId: session.sessionId,
      q: 'non usa npm',
    })}`,
    { token: harnessToken },
  );
  assert(!afterForget.items.some((memory) => memory.memoryId === second.memory.memoryId));
  await waitForGraphAbsent(second.memory.memoryId);
  const finalExport = await api('/v1/admin/exports/corpus', { token: ownerToken });
  assert(finalExport.memories.some((memory) => memory.current.memoryId === first.memory.memoryId));
  assert(
    !finalExport.memories.some((memory) => memory.current.memoryId === second.memory.memoryId),
  );
  assert(finalExport.forgetLedger.length === 1);
  assert(finalExport.conflicts.length === 0);
  const closed = await api(`/v1/sessions/${encodeURIComponent(session.sessionId)}/close`, {
    token: harnessToken,
    method: 'POST',
    key: 'e2e-close-session',
    body: {},
    status: 202,
  });
  await waitForJob(closed.jobId);
  await verifyBackupLifecycle();
  // After the final export, so the memory it creates cannot change what the
  // restore below is verified against.
  await verifyScopeIsolation();
  return {
    export: finalExport,
    sourceCorpusRevision: finalExport.corpusRevision,
    firstId: first.memory.memoryId,
    secondId: second.memory.memoryId,
  };
}

async function verifyBackupLifecycle() {
  backupTempDirectory = await mkdtemp(join(tmpdir(), 'mnemosyne-e2e-backup-'));
  const passphrasePath = join(backupTempDirectory, 'backup.pass');
  const backupPath = join(backupTempDirectory, 'e2e.dump');
  await writeFile(passphrasePath, 'synthetic-e2e-backup-passphrase-long-enough\n', { mode: 0o600 });
  execFileSync(
    process.execPath,
    [
      resolve(root, 'scripts/backup-postgres.mjs'),
      '--output',
      backupPath,
      '--verify-restore',
      '--encrypt',
      '--passphrase-file',
      passphrasePath,
    ],
    { cwd: root, env: environment, stdio: 'inherit' },
  );
  execFileSync(
    process.execPath,
    [
      resolve(root, 'scripts/restore-postgres.mjs'),
      '--input',
      backupPath,
      '--target-database',
      'mnemosyne_e2e_restored',
      '--confirm',
      '--passphrase-file',
      passphrasePath,
    ],
    { cwd: root, env: environment, stdio: 'inherit' },
  );
}

async function restoreAndVerify(lifecycle) {
  const restored = await api('/v1/admin/restore/corpus', {
    token: ownerToken,
    method: 'POST',
    key: 'e2e-restore',
    body: lifecycle.export,
  });
  assert(restored.restored.forgetLedger === 1);
  assert(restored.corpusRevision !== lifecycle.sourceCorpusRevision);
  assert(restored.corpusRevision.endsWith(':1'));
  const first = await api(`/v1/memories/${encodeURIComponent(lifecycle.firstId)}`, {
    token: harnessToken,
  });
  assert(first.content === 'il progetto usa npm');
  const second = await api(`/v1/memories/${encodeURIComponent(lifecycle.secondId)}`, {
    token: harnessToken,
    status: 404,
  });
  assert(second.code === 'memory_not_found');
  const feedback = await api(
    `/v1/memories/feedback?${new URLSearchParams({ memoryId: lifecycle.firstId })}`,
    { token: ownerToken },
  );
  const retention = await api('/v1/admin/retention', { token: ownerToken });
  assert(feedback.items.length === 0);
  assert(retention.lastRunAt === undefined);

  // A restore brings the corpus back but not the embeddings, so this is the
  // exact spot where search used to degrade to lexical-only with no signal.
  // The reindex command is the supported recovery, and health must be able to
  // say when it is needed.
  const beforeReindex = await api('/v1/admin/embeddings/health', { token: ownerToken });
  assert(beforeReindex.available === true, 'embedding_health_unavailable');
  assert(beforeReindex.profile === 'deterministic-v1');
  assert(beforeReindex.memoryCount === 2, `unexpected_memory_count:${beforeReindex.memoryCount}`);
  assert(beforeReindex.indexedForActiveProfile === 0, 'restore_should_not_carry_embeddings');
  assert(beforeReindex.missingCount === 2);
  assert(beforeReindex.needsReindex === true, 'needs_reindex_not_reported');

  const reindexed = await api('/v1/admin/embeddings/reindex', {
    token: ownerToken,
    method: 'POST',
    key: 'e2e-reindex',
    body: {},
  });
  assert(reindexed.scanned === 2, `unexpected_reindex_scan:${reindexed.scanned}`);
  assert(reindexed.indexed === 2);

  const afterReindex = await api('/v1/admin/embeddings/health', { token: ownerToken });
  assert(afterReindex.indexedForActiveProfile === 2, 'reindex_did_not_populate_index');
  assert(afterReindex.missingCount === 0);
  assert(afterReindex.needsReindex === false);
  assert(afterReindex.otherProfiles.length === 0);
}

async function review(pending, key) {
  return api(`/v1/proposals/${encodeURIComponent(pending.memoryId)}/decision`, {
    token: ownerToken,
    method: 'POST',
    key,
    body: { expectedVersion: pending.currentVersion, decision: 'accept' },
  });
}

async function waitForPending(sessionId, content) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const pending = await api(`/v1/proposals?${new URLSearchParams({ sessionId, limit: '100' })}`, {
      token: ownerToken,
    });
    const found = pending.items.find((memory) => memory.content === content);
    if (found) return found;
    await sleep(250);
  }
  throw new Error(`pending_not_found:${content}`);
}

async function verifyRuntimeCapabilities() {
  // The worker owns the extraction provider, Neo4j and the retention timer, and
  // publishes them as a heartbeat row. This exercises the real jsonb round trip
  // through Zod, which no unit test can cover.
  const deadline = Date.now() + 30_000;
  let capabilities = null;
  while (Date.now() < deadline) {
    capabilities = await api('/v1/admin/capabilities', { token: ownerToken });
    if (capabilities.workerObservedAt !== null) break;
    await sleep(250);
  }
  assert(capabilities.workerObservedAt !== null, 'worker_capability_heartbeat_missing');
  assert(capabilities.projections.neo4j === true, 'neo4j_capability_not_true');
  assert(capabilities.extraction.extractionProvider === 'local', 'unexpected_extraction_provider');
  assert(capabilities.operations.retentionManaged === true, 'retention_capability_not_true');
  assert(capabilities.operations.backupVerified === null, 'backup_verified_must_be_null');
  const gapFields = capabilities.gaps.map((gap) => gap.field);
  assert(gapFields.includes('operations.backupVerified'), 'backup_gap_missing');
  assert(!gapFields.includes('projections.neo4j'), 'neo4j_should_not_be_a_gap');
}

function psql(sql) {
  return compose(
    'exec',
    '-T',
    'postgres',
    'psql',
    '-v',
    'ON_ERROR_STOP=1',
    '-U',
    e2eDbUser,
    '-d',
    e2eDbName,
    '-t',
    '-A',
    '-c',
    sql,
  ).trim();
}

function psqlRejects(sql) {
  try {
    psql(sql);
    return false;
  } catch {
    return true;
  }
}

async function verifyProjectConstraints() {
  assert(
    psql("SELECT id FROM projects WHERE id = 'personal';") === 'personal',
    'reserved_personal_project_missing',
  );

  psql("INSERT INTO projects (id, name) VALUES ('e2e_alpha', 'E2E Alpha');");
  assert(
    psqlRejects("INSERT INTO projects (id, name) VALUES ('e2e_dup', 'e2e alpha');"),
    'project_name_case_insensitive_uniqueness_missing',
  );
  assert(
    psqlRejects("INSERT INTO projects (id, name) VALUES ('e2e_dup', 'E2E Alpha');"),
    'project_name_uniqueness_missing',
  );

  psql("INSERT INTO projects (id, name) VALUES ('e2e_beta', 'E2E Beta');");
  psql("INSERT INTO areas (id, project_id, name) VALUES ('e2e_a1', 'e2e_alpha', 'sviluppo');");
  assert(
    psqlRejects(
      "INSERT INTO areas (id, project_id, name) VALUES ('e2e_a2', 'e2e_alpha', 'sviluppo');",
    ),
    'area_name_uniqueness_per_project_missing',
  );
  // The same area name in another project is legal: areas are scoped, not global.
  psql("INSERT INTO areas (id, project_id, name) VALUES ('e2e_a3', 'e2e_beta', 'sviluppo');");

  psql("INSERT INTO sessions (id, project_id, status) VALUES ('e2e_s1', 'e2e_alpha', 'open');");
  assert(
    psqlRejects("DELETE FROM projects WHERE id = 'e2e_alpha';"),
    'project_with_sessions_should_not_be_deletable',
  );
  assert(
    psqlRejects(
      "INSERT INTO sessions (id, project_id, status) VALUES ('e2e_s2', 'e2e_ghost', 'open');",
    ),
    'session_project_foreign_key_missing',
  );

  // Leave nothing behind that a later assertion could trip over.
  psql("DELETE FROM sessions WHERE id = 'e2e_s1';");
  psql("DELETE FROM projects WHERE id IN ('e2e_alpha', 'e2e_beta');");
}

async function verifyArcConstraints() {
  // Arcs are governed rows, so the rules that matter are database rules. Cycles
  // between influences are legitimate; a cycle between hierarchical relations is
  // not, and only the latter is refused.
  psql("INSERT INTO projects (id, name) VALUES ('e2e_arc_a', 'E2E Arc A');");
  psql("INSERT INTO projects (id, name) VALUES ('e2e_arc_b', 'E2E Arc B');");
  psql("INSERT INTO projects (id, name) VALUES ('e2e_arc_c', 'E2E Arc C');");
  psql(
    "INSERT INTO memories (id, lifecycle, project_id) VALUES ('e2e_arc_m1', 'accepted', 'e2e_arc_a');",
  );
  psql(
    "INSERT INTO memories (id, lifecycle, project_id) VALUES ('e2e_arc_m2', 'accepted', 'e2e_arc_b');",
  );

  // Influences may cycle.
  psql(
    "INSERT INTO memory_arcs (from_memory_id, to_memory_id, type, weight, lifecycle) VALUES ('e2e_arc_m1', 'e2e_arc_m2', 'influenza', 0.7, 'accepted');",
  );
  psql(
    "INSERT INTO memory_arcs (from_memory_id, to_memory_id, type, weight, lifecycle) VALUES ('e2e_arc_m2', 'e2e_arc_m1', 'influenza', 0.4, 'accepted');",
  );
  // A self reference and an out of range weight are not legitimate.
  assert(
    psqlRejects(
      "INSERT INTO memory_arcs (from_memory_id, to_memory_id, type, weight, lifecycle) VALUES ('e2e_arc_m1', 'e2e_arc_m1', 'influenza', 0.5, 'accepted');",
    ),
    'memory_arc_self_reference_should_be_refused',
  );
  assert(
    psqlRejects(
      "INSERT INTO memory_arcs (from_memory_id, to_memory_id, type, weight, lifecycle) VALUES ('e2e_arc_m1', 'e2e_arc_m2', 'influenza', 2, 'accepted');",
    ),
    'memory_arc_weight_range_not_enforced',
  );

  // A hierarchy may not cycle.
  psql(
    "INSERT INTO project_arcs (from_project_id, to_project_id, type, weight, lifecycle) VALUES ('e2e_arc_a', 'e2e_arc_b', 'sotto-progetto', 1, 'accepted');",
  );
  psql(
    "INSERT INTO project_arcs (from_project_id, to_project_id, type, weight, lifecycle) VALUES ('e2e_arc_b', 'e2e_arc_c', 'sotto-progetto', 1, 'accepted');",
  );
  assert(
    psqlRejects(
      "INSERT INTO project_arcs (from_project_id, to_project_id, type, weight, lifecycle) VALUES ('e2e_arc_c', 'e2e_arc_a', 'sotto-progetto', 1, 'accepted');",
    ),
    'hierarchical_project_cycle_should_be_refused',
  );
  // A relation that is not declared hierarchical keeps its cycles.
  psql(
    "INSERT INTO project_arcs (from_project_id, to_project_id, type, lifecycle) VALUES ('e2e_arc_c', 'e2e_arc_a', 'dipende', 'accepted');",
  );
  // A proposal that has not been accepted cannot close a cycle.
  psql(
    "INSERT INTO project_arcs (from_project_id, to_project_id, type, lifecycle) VALUES ('e2e_arc_c', 'e2e_arc_a', 'sotto-progetto', 'pending_approval');",
  );

  psql("DELETE FROM memories WHERE id IN ('e2e_arc_m1', 'e2e_arc_m2');");
  psql("DELETE FROM projects WHERE id IN ('e2e_arc_a', 'e2e_arc_b', 'e2e_arc_c');");
}

async function verifyMemoryProjectIdentity() {
  // Self-contained on purpose: verifyProjectConstraints removes its own projects,
  // so reusing them here would depend on the order of two unrelated checks.
  psql("INSERT INTO projects (id, name) VALUES ('e2e_gamma', 'E2E Gamma');");
  psql("INSERT INTO projects (id, name) VALUES ('e2e_delta', 'E2E Delta');");
  psql(
    "INSERT INTO memories (id, lifecycle, project_id) VALUES ('e2e_m1', 'accepted', 'e2e_gamma');",
  );
  // Project membership is identity: the trigger refuses a move, so a future code
  // path cannot quietly break the invariant just because nothing updates it today.
  assert(
    psqlRejects("UPDATE memories SET project_id = 'e2e_delta' WHERE id = 'e2e_m1';"),
    'memory_project_should_be_immutable',
  );
  assert(
    psqlRejects("DELETE FROM projects WHERE id = 'e2e_gamma';"),
    'project_holding_memories_should_not_be_deletable',
  );
  // An update that leaves the project alone is still allowed.
  psql("UPDATE memories SET lifecycle = 'pending_approval' WHERE id = 'e2e_m1';");
  psql("DELETE FROM memories WHERE id = 'e2e_m1';");
  psql("DELETE FROM projects WHERE id IN ('e2e_gamma', 'e2e_delta');");
}

async function verifyScopeIsolation() {
  // Scope is derived from columns now, so the one thing worth proving is that a
  // memory in another project stays unreachable from this session's scopes. The
  // search filter was rewritten from a string comparison into three column
  // comparisons, and nothing else in this script would notice if it leaked.
  // Both sessions are opened here rather than reusing the lifecycle one: this
  // runs after that session is closed, and a closed session is not the subject
  // under test.
  const own = await api('/v1/sessions', {
    token: harnessToken,
    method: 'POST',
    key: 'e2e-isolation-own-session',
    body: { projectId: 'e2e-synthetic' },
    status: 201,
  });
  const other = await api('/v1/sessions', {
    token: harnessToken,
    method: 'POST',
    key: 'e2e-isolation-session',
    body: { projectId: 'e2e-alt' },
    status: 201,
  });
  const proposed = await api('/v1/proposals', {
    token: ownerToken,
    method: 'POST',
    key: 'e2e-isolation-proposal',
    body: {
      sessionId: other.sessionId,
      content: 'il progetto alternativo usa yarn',
      kind: 'convention',
      scope: { type: 'project', id: 'e2e-alt' },
      epistemicBasis: 'user_asserted',
      assessment: 'uncontested',
      confidence: 1,
      sensitivity: 'normal',
      activation: 'on_demand',
      sourceEventIds: [],
    },
    status: 201,
  });
  if (proposed.status === 'pending_approval') {
    await api(`/v1/proposals/${encodeURIComponent(proposed.memoryId)}/decision`, {
      token: ownerToken,
      method: 'POST',
      key: 'e2e-isolation-review',
      body: { expectedVersion: 1, decision: 'accept' },
      status: 200,
    });
  }

  const query = new URLSearchParams({ q: 'alternativo usa yarn', limit: '20' });
  const fromThisSession = await api(
    `/v1/memories?${new URLSearchParams({ ...Object.fromEntries(query), sessionId: own.sessionId })}`,
    { token: harnessToken },
  );
  assert(
    !fromThisSession.items.some((memory) => memory.memoryId === proposed.memoryId),
    'memory_leaked_across_projects',
  );

  const fromItsOwnSession = await api(
    `/v1/memories?${new URLSearchParams({ ...Object.fromEntries(query), sessionId: other.sessionId })}`,
    { token: harnessToken },
  );
  assert(
    fromItsOwnSession.items.some((memory) => memory.memoryId === proposed.memoryId),
    'memory_not_visible_in_its_own_project',
  );
}

async function searchToCreateCache(sessionId, memoryId) {
  const search = await api(
    `/v1/memories?${new URLSearchParams({
      sessionId,
      q: 'non usa npm',
    })}`,
    { token: harnessToken },
  );
  assert(search.items.some((memory) => memory.memoryId === memoryId));
}

async function waitForJob(jobId) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const job = await api(`/v1/jobs/${encodeURIComponent(jobId)}`, { token: harnessToken });
    if (job.status === 'succeeded') return;
    if (job.status === 'failed' || job.status === 'quarantined') {
      const attempts = await api(`/v1/admin/jobs/${encodeURIComponent(jobId)}/attempts`, {
        token: ownerToken,
      });
      throw new Error(`job_${job.status}:${JSON.stringify(attempts)}`);
    }
    await sleep(250);
  }
  throw new Error('job_timeout');
}

async function waitForApi() {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const response = await globalThis.fetch(`${apiUrl}/health/ready`);
      if (response.ok) return;
    } catch {
      // Compose is still starting.
    }
    await sleep(500);
  }
  throw new Error('api_readiness_timeout');
}

async function waitForGraph() {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (tryGraphCount() !== null) return;
    await sleep(500);
  }
  throw new Error('neo4j_readiness_timeout');
}

async function waitForGraphCount(expected) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (tryGraphCount() === expected) return;
    await sleep(250);
  }
  throw new Error(`neo4j_projection_timeout:${expected}`);
}

async function waitForGraphQuery(query, expected) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (tryGraphCount(query) === expected) return;
    await sleep(250);
  }
  throw new Error(`neo4j_projection_timeout:${expected}:${query}`);
}

async function waitForGraphAbsent(memoryId) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (tryGraphCount(`MATCH (m:Memory {id: ${quote(memoryId)}}) RETURN count(m);`) === 0) return;
    await sleep(250);
  }
  throw new Error('neo4j_forget_timeout');
}

function tryGraphCount(query = 'MATCH (m:Memory) RETURN count(m);') {
  try {
    const output = compose(
      'exec',
      '-T',
      'neo4j',
      'cypher-shell',
      '-u',
      environment.NEO4J_USERNAME,
      '-p',
      environment.NEO4J_PASSWORD,
      '--format',
      'plain',
      query,
    );
    const match = output.match(/(\d+)\s*$/u);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

function redisKeys() {
  return compose('exec', '-T', 'redis', 'redis-cli', '--raw', '--scan', '--pattern', 'mnemosyne:*')
    .split('\n')
    .map((key) => key.trim())
    .filter(Boolean);
}

async function waitForRedisEmpty() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (redisKeys().length === 0) return;
    await sleep(250);
  }
  throw new Error('redis_cache_forget_timeout');
}

async function api(path, options) {
  const headers = {
    accept: 'application/json',
    authorization: `Bearer ${options.token}`,
  };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.key) headers['idempotency-key'] = options.key;
  const response = await globalThis.fetch(`${apiUrl}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`invalid_json_response:${response.status}`);
    }
  }
  const expected = options.status ?? 200;
  if (response.status !== expected) {
    throw new Error(`http_${response.status}:${path}:${JSON.stringify(body)}`);
  }
  return body;
}

function compose(...args) {
  try {
    return execFileSync(
      'docker',
      ['compose', '--env-file', '/dev/null', '-p', project, '-f', composeFile, ...args],
      { cwd: root, env: environment, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`docker_compose_failed:${detail}`, { cause: error });
  }
}

function collectServiceLogs() {
  return compose('logs', '--no-color', '--tail=100', 'api', 'worker', 'neo4j');
}

function assert(condition, message = 'synthetic_assertion_failed') {
  if (!condition) throw new Error(message);
}

function quote(value) {
  return JSON.stringify(value);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function availablePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('available_port_failed'));
        return;
      }
      const port = address.port;
      server.close(() => resolvePort(port));
    });
  });
}
