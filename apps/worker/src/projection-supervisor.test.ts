import { describe, expect, it, vi } from 'vitest';
import { ProjectionSupervisor } from './projection-supervisor.js';

describe('ProjectionSupervisor', () => {
  it('keeps extraction polling alive when a derived projection fails', async () => {
    const projection = {
      rebuild: vi.fn().mockResolvedValue(undefined),
      runOnce: vi.fn().mockRejectedValue(new Error('neo4j_unavailable')),
    };
    const onError = vi.fn();
    const supervisor = new ProjectionSupervisor(projection, { onError });

    await expect(supervisor.runOnce()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'neo4j_unavailable' }));
  });

  it('retries a pending rebuild before processing outbox events', async () => {
    const projection = {
      rebuild: vi
        .fn()
        .mockRejectedValueOnce(new Error('neo4j_unavailable'))
        .mockResolvedValueOnce(undefined),
      runOnce: vi.fn().mockResolvedValue(1),
    };
    const onError = vi.fn();
    const supervisor = new ProjectionSupervisor(projection, { rebuildOnStart: true, onError });

    await supervisor.runOnce();
    await supervisor.runOnce();

    expect(projection.rebuild).toHaveBeenCalledTimes(2);
    expect(projection.runOnce).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledOnce();
  });

  it('retries outbox delivery without marking failed events as processed', async () => {
    const projection = {
      rebuild: vi.fn().mockResolvedValue(undefined),
      runOnce: vi
        .fn()
        .mockRejectedValueOnce(new Error('neo4j_unavailable'))
        .mockResolvedValueOnce(1),
    };
    const onError = vi.fn();
    const supervisor = new ProjectionSupervisor(projection, { onError });

    await supervisor.runOnce();
    await supervisor.runOnce();

    expect(projection.runOnce).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledOnce();
  });
});
