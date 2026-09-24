export interface DerivedProjection {
  rebuild(): Promise<void>;
  runOnce(): Promise<number>;
}

export interface ProjectionSupervisorOptions {
  rebuildOnStart?: boolean;
  onError: (error: unknown) => void;
}

export class ProjectionSupervisor {
  private rebuildPending: boolean;
  private readonly onError: (error: unknown) => void;

  constructor(
    private readonly projection: DerivedProjection,
    options: ProjectionSupervisorOptions,
  ) {
    this.rebuildPending = options.rebuildOnStart ?? false;
    this.onError = options.onError;
  }

  async runOnce(): Promise<void> {
    try {
      if (this.rebuildPending) {
        await this.projection.rebuild();
        this.rebuildPending = false;
      }
      await this.projection.runOnce();
    } catch (error) {
      this.onError(error);
    }
  }
}
