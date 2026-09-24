export const retryableProviderErrorCodes = [
  'extraction_provider_timeout',
  'extraction_provider_unavailable',
  'extraction_temporarily_unavailable',
] as const;

export class ExtractionProviderError extends Error {
  constructor(
    public readonly code: string,
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = 'ExtractionProviderError';
  }
}

export function providerErrorCode(error: unknown): string {
  if (error instanceof ExtractionProviderError) return error.code;
  if (error instanceof Error) return error.message;
  return 'extraction_provider_failed';
}

export function isRetryableProviderError(
  error: unknown,
  additionalCodes: readonly string[] = [],
): boolean {
  const code = providerErrorCode(error);
  return new Set<string>([...retryableProviderErrorCodes, ...additionalCodes]).has(code);
}

export function providerHttpErrorCode(
  status: number,
): 'extraction_provider_unavailable' | 'extraction_provider_http_error' {
  if (status === 408 || status === 429 || status >= 500) {
    return 'extraction_provider_unavailable';
  }
  return 'extraction_provider_http_error';
}
