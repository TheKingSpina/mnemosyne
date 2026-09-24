import { ExtractionProviderError, type Extractor } from '@mnemosyne/core';

export interface ProviderRoute {
  name: string;
  extractor: Extractor;
}

export class ProviderRouter implements Extractor {
  private readonly routes: readonly ProviderRoute[];

  constructor(routes: readonly ProviderRoute[]) {
    if (routes.length === 0) throw new Error('provider_router_requires_route');
    this.routes = [...routes];
  }

  async extract(input: Parameters<Extractor['extract']>[0]): Promise<unknown> {
    let lastError: unknown;
    for (const route of this.routes) {
      try {
        return await route.extractor.extract(input);
      } catch (error) {
        if (error instanceof ExtractionProviderError) {
          lastError = error;
          continue;
        }
        throw error;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new ExtractionProviderError('extraction_provider_failed');
  }
}
