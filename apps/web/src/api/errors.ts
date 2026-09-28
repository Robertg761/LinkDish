/**
 * The web app's API error type. Same shape as `ExtractorApiError` in @linkdish/api-client, but
 * defined here so screens can use it without pulling the API client (and zod) into the entry
 * chunk. The lazy client in ./client converts the package's errors into this class.
 */
/** Mirrors `ExtractorApiErrorKind` in @linkdish/api-client. */
export type WebApiErrorKind = "network" | "timeout" | "http" | "contract" | "validation";

export class ExtractorApiError extends Error {
  /** How the request failed. Defaults to "http", matching errors created before kinds existed. */
  public readonly kind: WebApiErrorKind;
  /** The API's own `message` from the error body, when it sent one. */
  public readonly serverMessage: string | undefined;

  public constructor(
    message: string,
    public readonly statusCode: number,
    public readonly details?: unknown,
    options: { kind?: WebApiErrorKind | undefined; serverMessage?: string | undefined } = {}
  ) {
    super(message);
    this.name = "ExtractorApiError";
    this.kind = options.kind ?? "http";
    this.serverMessage = options.serverMessage;
  }
}

const readErrorKind = (error: unknown): WebApiErrorKind | undefined => {
  const kind = (error as { kind?: unknown }).kind;
  return kind === "network" ||
    kind === "timeout" ||
    kind === "http" ||
    kind === "contract" ||
    kind === "validation"
    ? kind
    : undefined;
};

/** The failure kind of any API error (web or package class); undefined for other errors. */
export const getApiErrorKind = (error: unknown): WebApiErrorKind | undefined =>
  isExtractorApiError(error) ? (readErrorKind(error) ?? "http") : undefined;

/** True for this class and for the package's class (e.g. errors from mocked clients in tests). */
export const isExtractorApiError = (
  error: unknown
): error is Error & { details?: unknown; statusCode: number } =>
  error instanceof ExtractorApiError ||
  (error instanceof Error &&
    error.name === "ExtractorApiError" &&
    typeof (error as { statusCode?: unknown }).statusCode === "number");

const readServerMessage = (error: unknown): string | undefined => {
  const serverMessage = (error as { serverMessage?: unknown }).serverMessage;
  return typeof serverMessage === "string" ? serverMessage : undefined;
};

/** Re-types an API client error as the web {@link ExtractorApiError}; other errors pass through. */
export const toWebApiError = (error: unknown): unknown =>
  !(error instanceof ExtractorApiError) && isExtractorApiError(error)
    ? new ExtractorApiError(error.message, error.statusCode, error.details, {
        kind: readErrorKind(error),
        serverMessage: readServerMessage(error)
      })
    : error;
