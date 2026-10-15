import neo4j, { type Driver } from 'neo4j-driver';
import { randomUUID } from 'node:crypto';
import type { MemoryArc, MemoryRepository, OutboxEvent, ProjectArc } from '@mnemosyne/core';

export interface Neo4jProjectionOptions {
  uri: string;
  username: string;
  password: string;
  database?: string;
  batchSize?: number;
  consumerId?: string;
  leaseMs?: number;
}

export class Neo4jProjection {
  private readonly driver: Driver;
  private readonly database?: string;
  private readonly batchSize: number;
  private readonly consumerId: string;
  private readonly leaseMs: number;

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
    this.consumerId = options.consumerId ?? `neo4j-${process.pid}-${randomUUID()}`;
    this.leaseMs = options.leaseMs ?? 30_000;
    if (!Number.isSafeInteger(this.batchSize) || this.batchSize < 1 || this.batchSize > 1_000) {
      throw new Error('neo4j_batch_size_invalid');
    }
    if (this.consumerId.trim().length === 0) throw new Error('neo4j_consumer_id_required');
    if (!Number.isSafeInteger(this.leaseMs) || this.leaseMs < 1) {
      throw new Error('neo4j_outbox_lease_invalid');
    }
  }

  async close(): Promise<void> {
    await this.driver.close();
  }

  async runOnce(): Promise<number> {
    const claim = await this.repository.claimOutboxEvents(
      this.batchSize,
      this.consumerId,
      this.leaseMs,
    );
    if (!claim) return 0;
    for (const event of claim.events) await this.apply(event);
    await this.repository.markOutboxProcessed(claim);
    return claim.events.length;
  }

  async rebuild(): Promise<void> {
    const memories = await this.repository.listMemoryViews();
    const conflicts = await this.repository.listAllConflicts();
    const memoryArcs = await this.repository.listAllMemoryArcs();
    const projectArcs = await this.repository.listAllProjectArcs();
    // Roots come from the governed tables, not from the memories pointing at
    // them: a project with memories but no arcs still gets its node, and an
    // area with no memories in it still exists as a subgraph root.
    const projects = await this.repository.listProjects();
    const projectNames = new Map(projects.map((project) => [project.id, project.name]));
    const areaById = new Map<string, { name: string; projectId: string }>();
    for (const project of projects) {
      for (const area of await this.repository.listAreas(project.id)) {
        areaById.set(area.id, { name: area.name, projectId: area.projectId });
      }
    }
    const session = this.driver.session(this.database ? { database: this.database } : {});
    try {
      await session.executeWrite((tx) => tx.run('MATCH (n) DETACH DELETE n'));
      for (const project of projects) {
        await session.executeWrite((tx) =>
          tx.run('MERGE (p:Project {id: $id}) SET p.name = $name', {
            id: project.id,
            name: project.name,
          }),
        );
      }
      for (const [areaId, area] of areaById) {
        await session.executeWrite((tx) =>
          tx.run(
            `MERGE (a:Area {id: $id})
             SET a.name = $name, a.projectId = $projectId
             WITH a
             MERGE (p:Project {id: $projectId})
             MERGE (a)-[:PART_OF]->(p)`,
            {
              id: areaId,
              name: area.name,
              projectId: area.projectId,
            },
          ),
        );
      }
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
             MERGE (p:Project {id: $projectId})
             SET p.name = $projectName
             MERGE (m)-[:IN_PROJECT]->(p)`,
            {
              id: current.memoryId,
              version: neo4j.int(current.version),
              content: current.content,
              kind: current.kind,
              scopeType: current.scope.type,
              scopeId: current.scope.id,
              lifecycle: memory.record.lifecycle,
              projectId: memory.record.projectId,
              projectName: projectNames.get(memory.record.projectId) ?? memory.record.projectId,
            },
          ),
        );
        // Only area-scoped memories get the second edge. A project root with
        // no areas in use still stands from the loop above; inventing an edge
        // for a memory that has no area would put structure in the graph that
        // the corpus does not have.
        if (current.scope.type === 'area') {
          const area = areaById.get(current.scope.id);
          await session.executeWrite((tx) =>
            tx.run(
              `MERGE (a:Area {id: $id})
               SET a.name = $name, a.projectId = $projectId
               WITH a
               MATCH (m:Memory {id: $memoryId})
               MERGE (m)-[:IN_AREA]->(a)`,
              {
                id: current.scope.id,
                name: area?.name ?? current.scope.id,
                projectId: area?.projectId ?? memory.record.projectId,
                memoryId: current.memoryId,
              },
            ),
          );
        }
      }
      for (const conflict of conflicts) {
        if (conflict.status !== 'open') continue;
        if (conflict.memoryIds.length < 2) continue;
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
      // Accepted arcs are part of the graph, so a rebuild has to restore them.
      // A wiped projection that came back without its arcs would be a silent
      // corruption of what the dashboard shows.
      for (const arc of memoryArcs) {
        if (arc.lifecycle !== 'accepted') continue;
        await session.executeWrite((tx) =>
          tx.run(
            `MATCH (a:Memory {id: $from})
             MATCH (b:Memory {id: $to})
             MERGE (a)-[r:LINK {id: $id}]->(b)
             SET r.type = $type, r.weight = $weight`,
            {
              id: arc.id,
              from: arc.fromMemoryId,
              to: arc.toMemoryId,
              type: arc.type,
              weight: arc.weight,
            },
          ),
        );
      }
      for (const arc of projectArcs) {
        if (arc.lifecycle !== 'accepted') continue;
        const from = await this.repository.findProjectById(arc.fromProjectId);
        const to = await this.repository.findProjectById(arc.toProjectId);
        if (!from || !to) continue;
        await session.executeWrite((tx) =>
          tx.run(
            `MERGE (a:Project {id: $fromId}) SET a.name = $fromName
             MERGE (b:Project {id: $toId}) SET b.name = $toName
             MERGE (a)-[r:LINK {id: $id}]->(b)
             SET r.type = $type, r.weight = $weight`,
            {
              id: arc.id,
              fromId: arc.fromProjectId,
              fromName: from.name,
              toId: arc.toProjectId,
              toName: to.name,
              type: arc.type,
              weight: arc.weight,
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
      if (event.eventType === 'memory.conflict.updated') {
        const conflict = await this.repository.getConflict(event.aggregateId);
        if (!conflict) return;
        await session.executeWrite((tx) =>
          tx.run('MATCH ()-[r:CONFLICTS {id: $id}]->() DELETE r', { id: conflict.id }),
        );
        if (conflict.memoryIds.length < 2) return;
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
        return;
      }
      if (event.eventType === 'memory.conflict.created') {
        const conflict = await this.repository.getConflict(event.aggregateId);
        if (!conflict) return;
        if (conflict.memoryIds.length < 2) return;
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
        return;
      }
      if (event.eventType === 'memory.conflict.resolved') {
        await session.executeWrite((tx) =>
          tx.run(
            `MATCH (a)-[r:CONFLICTS {id: $id}]->(b)
             SET r.status = 'resolved'`,
            { id: event.aggregateId },
          ),
        );
        return;
      }
      if (event.eventType === 'arc.accepted') {
        // Only accepted arcs reach the graph. A proposed arc must not appear:
        // the point of the lifecycle is that the graph shows what was approved.
        const arc = event.payload as unknown as MemoryArc;
        await session.executeWrite((tx) =>
          tx.run(
            `MATCH (a:Memory {id: $from})
             MATCH (b:Memory {id: $to})
             MERGE (a)-[r:LINK {id: $id}]->(b)
             SET r.type = $type, r.weight = $weight`,
            {
              id: arc.id,
              from: arc.fromMemoryId,
              to: arc.toMemoryId,
              type: arc.type,
              weight: arc.weight,
            },
          ),
        );
        return;
      }
      if (event.eventType === 'project_arc.accepted') {
        const arc = event.payload as unknown as ProjectArc;
        const from = await this.repository.findProjectById(arc.fromProjectId);
        const to = await this.repository.findProjectById(arc.toProjectId);
        if (!from || !to) return;
        await session.executeWrite((tx) =>
          tx.run(
            `MERGE (a:Project {id: $fromId}) SET a.name = $fromName
             MERGE (b:Project {id: $toId}) SET b.name = $toName
             MERGE (a)-[r:LINK {id: $id}]->(b)
             SET r.type = $type, r.weight = $weight`,
            {
              id: arc.id,
              fromId: arc.fromProjectId,
              fromName: from.name,
              toId: arc.toProjectId,
              toName: to.name,
              type: arc.type,
              weight: arc.weight,
            },
          ),
        );
        return;
      }
      const memory = await this.repository.getMemory(event.aggregateId);
      if (!memory) return;
      const current = memory.current;
      const project = await this.repository.findProjectById(memory.record.projectId);
      await session.executeWrite((tx) =>
        tx.run(
          `MERGE (m:Memory {id: $id})
           SET m.version = $version,
               m.content = $content,
               m.kind = $kind,
               m.scopeType = $scopeType,
               m.scopeId = $scopeId,
               m.lifecycle = $lifecycle
           MERGE (p:Project {id: $projectId})
           SET p.name = $projectName
           MERGE (m)-[:IN_PROJECT]->(p)`,
          {
            id: current.memoryId,
            version: neo4j.int(current.version),
            content: current.content,
            kind: current.kind,
            scopeType: current.scope.type,
            scopeId: current.scope.id,
            lifecycle: memory.record.lifecycle,
            projectId: memory.record.projectId,
            projectName: project?.name ?? memory.record.projectId,
          },
        ),
      );
      // A re-scoped memory keeps its old IN_AREA edge unless it is removed:
      // the project edge cannot go stale because project membership never
      // changes, but the area edge must follow the current scope.
      await session.executeWrite((tx) =>
        tx.run('MATCH (m:Memory {id: $id})-[r:IN_AREA]->() DELETE r', {
          id: current.memoryId,
        }),
      );
      if (current.scope.type === 'area') {
        const area = await this.repository.findAreaById(current.scope.id);
        await session.executeWrite((tx) =>
          tx.run(
            `MERGE (a:Area {id: $id})
             SET a.name = $name, a.projectId = $projectId
             WITH a
             MERGE (p:Project {id: $projectId})
             MERGE (a)-[:PART_OF]->(p)
             WITH a
             MATCH (m:Memory {id: $memoryId})
             MERGE (m)-[:IN_AREA]->(a)`,
            {
              id: current.scope.id,
              name: area?.name ?? current.scope.id,
              projectId: area?.projectId ?? memory.record.projectId,
              memoryId: current.memoryId,
            },
          ),
        );
      }
    } finally {
      await session.close();
    }
  }
}
