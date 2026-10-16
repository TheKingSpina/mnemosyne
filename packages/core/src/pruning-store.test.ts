import { describe, expect, it } from 'vitest';
import { InMemoryRepository } from './in-memory-repository.js';

function repository() {
  return new InMemoryRepository();
}

describe('pruning proposals', () => {
  it('creates pending proposals and filters them by status', async () => {
    const repo = repository();
    const first = await repo.createPruningProposal({
      batchId: 'batch-1',
      proposer: 'deterministic',
      proposalType: 'decay',
      sourceIds: ['mem_1'],
      sourceVersions: { mem_1: 2 },
      rationale: 'old and unlinked',
      confidence: 0.2,
      scoreSnapshot: { recency: 0.1, edgeWeight: 0.5, kind: 0.3 },
    });

    expect(first.status).toBe('pending');
    expect(first.decidedAt).toBeUndefined();
    expect(await repo.listPruningProposals()).toHaveLength(1);
    expect(await repo.listPruningProposals('pending')).toHaveLength(1);
    expect(await repo.listPruningProposals('accepted')).toHaveLength(0);

    const decided = await repo.updatePruningProposalStatus(first.id, 'accepted', 'score held');
    expect(decided.status).toBe('accepted');
    expect(decided.decidedAt).toBeDefined();
    expect(decided.decisionReason).toBe('score held');
    expect(await repo.listPruningProposals('pending')).toHaveLength(0);
  });

  it('refuses to decide a proposal that does not exist', async () => {
    await expect(
      repository().updatePruningProposalStatus('pruning_missing', 'rejected', 'nope'),
    ).rejects.toThrow('pruning_proposal_not_found');
  });

  it('records ledger rows with the decision context', async () => {
    const repo = repository();
    const proposal = await repo.createPruningProposal({
      batchId: 'batch-1',
      proposer: 'deterministic',
      proposalType: 'edge',
      sourceIds: ['arc_1'],
      sourceVersions: { arc_1: 0.1 },
      rationale: 'weak link',
      confidence: 0.1,
      scoreSnapshot: { weight: 0.1 },
    });
    const entry = await repo.recordPruningLedgerEntry({
      subjectType: 'arc',
      subjectId: 'arc_1',
      reason: 'edge_weight',
      proposalId: proposal.id,
      score: 0.1,
      scoreComponents: { weight: 0.1 },
    });

    expect(entry.proposalId).toBe(proposal.id);
    expect(await repo.listPruningLedger()).toHaveLength(1);
  });
});

describe('arc deletion', () => {
  it('deletes arcs and refuses missing ones', async () => {
    const repo = repository();
    await repo.createProject({ id: 'p1', name: 'P1' });
    await repo.createProject({ id: 'p2', name: 'P2' });
    const arc = await repo.createProjectArc({
      fromProjectId: 'p1',
      toProjectId: 'p2',
      type: 'dipende',
    });

    await repo.deleteProjectArc(arc.id);
    expect(await repo.listAllProjectArcs()).toHaveLength(0);
    await expect(repo.deleteProjectArc(arc.id)).rejects.toThrow('arc_not_found');
    await expect(repo.deleteMemoryArc('arc_missing')).rejects.toThrow('arc_not_found');
  });
});
