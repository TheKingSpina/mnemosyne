import neo4j, { type Driver } from 'neo4j-driver';
import type { MemoryRepository, OutboxEvent } from '@mnemosyne/core';

export interface Neo4jProjectionOptions {
  uri: string;
  username: string;
  password: string;
  database?: string;
  batchSize?: number;
}

export class Neo4jProjection {
  private readonly driver: Driver;
  private readonly database?: string;
  private readonly batchSize: number;

  constructor(
    private readonly repository: MemoryRepository,
    options: Neo4jProjectionOptions,
  ) {
    if (options.uri.trim().length === 0) throw new Error('neo4j_uri_required');
    if (options.username.trim().length === 0) throw new Error('neo4j_username_required');
    if (options.password.length === 0) throw new Error('neo4j_password_required');
    this.driver = neo4j.driver(options.uri, neo4j.auth.basic(options.username, options.password));
    this.database = options.database;
    this.batchSize = options.batchSize ?? 100;
    if (!Number.isSafeInteger(this.batchSize) || this.batchSize < 1 || this.batchSize > 1_000) {
      throw new Error('neo4j_batch_size_invalid');
    }
  }

  async close(): Promise<void> {
    await this.driver.close();
  }

  async runOnce(): Promise<number> {
    const events = await this.repository.claimOutboxEvents(this.batchSize);
    for (const event of events) await this.apply(event);
    await this.repository.markOutboxProcessed(events.map((event) => event.id));
    return events.length;
  }

  async rebuild(): Promise<void> {
    const memories = await this.repository.listMemoryViews();
    const conflicts = await this.repository.listAllConflicts();
    const session = this.driver.session(this.database ? { database: this.database } : {});
    try {
      await session.executeWrite((tx) => tx.run('MATCH (n) DETACH DELETE n'));
      for (const memory of memories) {
        const current = memory.current;
        await session.executeWrite((tx) =>
          tx.run(
            `MERGE (m:Memory {id: $id})
             SET m.version = $version,
                 m.content = $content,
                 m.kind = $kind,
                 m.scopeType = $scopeType,
                 m.scopeId = $scopeId,
                 m.lifecycle = $lifecycle
             MERGE (s:Scope {type: $scopeType, id: $scopeId})
             MERGE (m)-[:IN_SCOPE]->(s)`,
            {
              id: current.memoryId,
              version: neo4j.int(current.version),
              content: current.content,
              kind: current.kind,
              scopeType: current.scope.type,
              scopeId: current.scope.id,
              lifecycle: memory.record.lifecycle,
            },
          ),
        );
      }
      for (const conflict of conflicts) {
        await session.executeWrite((tx) =>
          tx.run(
            `MATCH (a:Memory {id: $first}), (b:Memory {id: $second})
             MERGE (a)-[:CONFLICTS {id: $id, type: $type, status: $status}]->(b)`,
            {
              id: conflict.id,
              type: conflict.type,
              status: conflict.status,
              first: conflict.memoryIds[0],
              second: conflict.memoryIds[1],
            },
          ),
        );
      }
    } finally {
      await session.close();
    }
  }

  private async apply(event: OutboxEvent): Promise<void> {
    const session = this.driver.session(this.database ? { database: this.database } : {});
    try {
      if (event.eventType === 'memory.forgotten') {
        await session.executeWrite((tx) =>
          tx.run('MATCH (m:Memory {id: $id}) DETACH DELETE m', { id: event.aggregateId }),
        );
        return;
      }
      const memory = await this.repository.getMemory(event.aggregateId);
      if (!memory || memory.record.lifecycle !== 'accepted') return;
      const current = memory.current;
      await session.executeWrite((tx) =>
        tx.run(
          `MERGE (m:Memory {id: $id})
           SET m.version = $version,
               m.content = $content,
               m.kind = $kind,
               m.scopeType = $scopeType,
               m.scopeId = $scopeId,
               m.lifecycle = $lifecycle
           MERGE (s:Scope {type: $scopeType, id: $scopeId})
           MERGE (m)-[:IN_SCOPE]->(s)`,
          {
            id: current.memoryId,
            version: neo4j.int(current.version),
            content: current.content,
            kind: current.kind,
            scopeType: current.scope.type,
            scopeId: current.scope.id,
            lifecycle: memory.record.lifecycle,
          },
        ),
      );
    } finally {
      await session.close();
    }
  }
}
