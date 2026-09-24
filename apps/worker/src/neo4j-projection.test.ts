import { describe, expect, it } from 'vitest';
import { InMemoryRepository } from '@mnemosyne/core';
import { Neo4jProjection } from './neo4j-projection.js';

function createProjection(repository: InMemoryRepository): Neo4jProjection {
  return new Neo4jProjection(repository, {
    uri: 'bolt://127.0.0.1:7687',
    username: 'synthetic-user',
    password: 'synthetic-password',
    batchSize: 2,
  });
}

describe('Neo4jProjection', () => {
  it('requires an explicit Neo4j endpoint and credentials', () => {
    expect(
      () =>
        new Neo4jProjection(new InMemoryRepository(), {
          uri: '',
          username: 'synthetic-user',
          password: 'synthetic-password',
        }),
    ).toThrow('neo4j_uri_required');
  });

  it('is constructed as a derived projection boundary', () => {
    const repository = new InMemoryRepository();
    const projection = createProjection(repository);
    expect(projection).toBeInstanceOf(Neo4jProjection);
  });

  it('rejects an empty outbox consumer id', () => {
    expect(
      () =>
        new Neo4jProjection(new InMemoryRepository(), {
          uri: 'bolt://127.0.0.1:7687',
          username: 'synthetic-user',
          password: 'synthetic-password',
          consumerId: '',
        }),
    ).toThrow('neo4j_consumer_id_required');
  });

  it('rejects an invalid outbox lease', () => {
    expect(
      () =>
        new Neo4jProjection(new InMemoryRepository(), {
          uri: 'bolt://127.0.0.1:7687',
          username: 'synthetic-user',
          password: 'synthetic-password',
          leaseMs: 0,
        }),
    ).toThrow('neo4j_outbox_lease_invalid');
  });
});
