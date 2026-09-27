/*
 * One deadline per /extract request. api/extract.ts runs with maxDuration 60 s,
 * and the old per-step timeouts could add up past it (HTTP retries, a browser
 * render, an LLM cleanup and two 30 s Gemini attempts), which surfaced as a 504
 * that clients then retried. Every outbound step now derives its timeout from
 * the time left, and the signal also aborts when the caller cancels (for
 * example when billing denies a request whose fetch already started).
 */
export interface RequestDeadline {
  /** Aborts when the deadline passes or the parent signal aborts. */
  readonly signal: AbortSignal;
  readonly expiresAt: number;
  remainingMs(): number;
  /** A step timeout: at most `preferredMs`, leaving `reserveMs` of the deadline for later work. */
  budgetMs(preferredMs: number, reserveMs?: number): number;
  dispose(): void;
}

export class ExtractionCancelledError extends Error {
  public constructor(message = "Extraction was cancelled before it finished.") {
    super(message);
    this.name = "ExtractionCancelledError";
  }
}

export const createRequestDeadline = (
  durationMs: number,
  parentSignal?: AbortSignal
): RequestDeadline => {
  const controller = new AbortController();
  const expiresAt = Date.now() + durationMs;
  const timeoutId = setTimeout(() => {
    controller.abort(new DOMException("The request deadline passed.", "TimeoutError"));
  }, durationMs);
  const abortFromParent = () => controller.abort(parentSignal?.reason);

  if (parentSignal?.aborted) {
    abortFromParent();
  } else {
    parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  }

  const remainingMs = () => Math.max(0, expiresAt - Date.now());

  return {
    signal: controller.signal,
    expiresAt,
    remainingMs,
    budgetMs: (preferredMs, reserveMs = 0) =>
      Math.max(0, Math.min(preferredMs, remainingMs() - reserveMs)),
    dispose: () => {
      clearTimeout(timeoutId);
      parentSignal?.removeEventListener("abort", abortFromParent);
    }
  };
};

export const isAbortError = (error: unknown): boolean =>
  error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
