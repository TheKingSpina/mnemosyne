import { CoreMemoryService, InMemoryRepository } from '@mnemosyne/core';
import neo4j, { type Driver } from 'neo4j-driver';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Neo4jProjection } from './neo4j-projection.js';

const neo4jUri = process.env.MNEMOSYNE_TEST_NEO4J_URI;
const neo4jPassword = process.env.MNEMOSYNE_TEST_NEO4J_PASSWORD;
const describeRuntime = neo4jUri && neo4jPassword ? describe : describe.skip;

let projection: Neo4jProjection;
let graph: ReturnType<Driver['session']>;
let repository: InMemoryRepository;
let service: CoreMemoryService;

beforeAll(async () => {
  if (!neo4jUri || !neo4jPassword) return;
  repository = new InMemoryRepository();
  service = new CoreMemoryService(repository, {
    forgetSecret: 'synthetic-forget-secret-that-is-long-enough-123456',
  });
  projection = new Neo4jProjection(repository, {
    uri: neo4jUri,
    username: 'neo4j',
    password: neo4jPassword,
    batchSize: 100,
  });
  graph = neo4j.driver(neo4jUri, neo4j.auth.basic('neo4j', neo4jPassword)).session();
  await graph.run('MATCH (n) DETACH DELETE n');
});

afterAll(async () => {
  if (!neo4jUri || !neo4jPassword) return;
  await graph.close();
  await projection.close();
});

describeRuntime('Neo4jProjection runtime', () => {
  it('projects accepted memories, corrections, conflicts, forget, and rebuilds', async () => {
    const session = await service.openSession({ projectId: 'neo4j-runtime' });
    const memory = await service.proposeMemory(
      {
        sessionId: session.sessionId,
        content: 'Il progetto usa npm',
        kind: 'convention',
        scope: { type: 'project', id: 'neo4j-runtime' },
        epistemicBasis: 'user_asserted',
        assessment: 'uncontested',
        confidence: 1,
        sensitivity: 'normal',
        activation: 'on_demand',
        sourceEventIds: [],
      },
      { actor: 'owner', explicitDirective: true },
    );
    await projection.runOnce();
    const accepted = await graph.run(
      `MATCH (m:Memory {id: $id})
       OPTIONAL MATCH (m)-[:IN_SCOPE]->(s:Scope)
       RETURN m.version AS version, m.content AS content, count(s) AS scopes`,
      { id: memory.memoryId },
    );

    expect(integerValue(accepted.records[0]?.get('version'))).toBe(1);
    expect(accepted.records[0]?.get('content')).toBe('Il progetto usa npm');
    expect(integerValue(accepted.records[0]?.get('scopes'))).toBe(1);

    await service.correctMemory({
      memoryId: memory.memoryId!,
      expectedVersion: 1,
      content: 'Il progetto usa pnpm',
    });
    await projection.runOnce();
    const corrected = await graph.run(
      `MATCH (m:Memory {id: $id})
       OPTIONAL MATCH (m)-[:IN_SCOPE]->(s:Scope)
       RETURN m.version AS version, m.content AS content,
              collect(s.type + ':' + s.id) AS scopes`,
      { id: memory.memoryId },
    );

    expect(integerValue(corrected.records[0]?.get('version'))).toBe(2);
    expect(corrected.records[0]?.get('content')).toBe('Il progetto usa pnpm');
    expect(corrected.records[0]?.get('scopes')).toEqual(['project:neo4j-runtime']);

    const contradiction = await service.proposeMemory({
      sessionId: session.sessionId,
      content: 'Il progetto non usa pnpm',
      kind: 'convention',
      scope: { type: 'project', id: 'neo4j-runtime' },
      epistemicBasis: 'user_asserted',
      assessment: 'disputed',
      confidence: 1,
      sensitivity: 'normal',
      activation: 'on_demand',
      sourceEventIds: [],
    });
    await projection.runOnce();
    const conflict = await graph.run(
      `MATCH (m:Memory {id: $id})
       OPTIONAL MATCH ()-[r:CONFLICTS]->(m)
       RETURN count(r) AS conflicts`,
      { id: contradiction.memoryId },
    );

    expect(integerValue(conflict.records[0]?.get('conflicts'))).toBe(1);

    await service.resolveConflict(contradiction.conflictId!);
    await projection.runOnce();
    const resolved = await graph.run(
      `MATCH ()-[r:CONFLICTS {id: $id}]->() RETURN r.status AS status`,
      { id: contradiction.conflictId },
    );
    expect(resolved.records[0]?.get('status')).toBe('resolved');

    await projection.rebuild();
    const rebuilt = await graph.run(`MATCH ()-[r:CONFLICTS]->() RETURN count(r) AS conflicts`);
    expect(integerValue(rebuilt.records[0]?.get('conflicts'))).toBe(0);

    const prepared = await service.prepareForget(memory.memoryId!);
    await service.forgetMemory(memory.memoryId!, prepared.confirmationToken);
    await projection.runOnce();
    const forgotten = await graph.run('MATCH (m:Memory {id: $id}) RETURN count(m) AS count', {
      id: memory.memoryId,
    });

    expect(integerValue(forgotten.records[0]?.get('count'))).toBe(0);
  });
});

function integerValue(value: unknown): number {
  if (neo4j.isInt(value)) return value.toNumber();
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  throw new Error('neo4j_test_integer_expected');
}
