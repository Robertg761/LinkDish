/**
 * The web app's API error type. Same shape as `ExtractorApiError` in @linkdish/api-client, but
 * defined here so screens can use it without pulling the API client (and zod) into the entry
 * chunk. The lazy client in ./client converts the package's errors into this class.
 */
export class ExtractorApiError extends Error {
  public constructor(
    message: string,
    public readonly statusCode: number,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = "ExtractorApiError";
  }
}

/** True for this class and for the package's class (e.g. errors from mocked clients in tests). */
export const isExtractorApiError = (
  error: unknown
): error is Error & { details?: unknown; statusCode: number } =>
  error instanceof ExtractorApiError ||
  (error instanceof Error &&
    error.name === "ExtractorApiError" &&
    typeof (error as { statusCode?: unknown }).statusCode === "number");

/** Re-types an API client error as the web {@link ExtractorApiError}; other errors pass through. */
export const toWebApiError = (error: unknown): unknown =>
  !(error instanceof ExtractorApiError) && isExtractorApiError(error)
    ? new ExtractorApiError(error.message, error.statusCode, error.details)
    : error;
