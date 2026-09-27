import type { InternalFetchFailureKind } from "../types.js";

/*
 * Fetch error classes live in their own dependency-free module so the extract
 * orchestrator can classify failures without statically importing the
 * fetchers (and, through them, the HTML parser) on the cold-start path.
 */
export class HtmlFetchError extends Error {
  public constructor(
    message: string,
    public readonly reason: InternalFetchFailureKind,
    public readonly blockedSignals: string[] = [],
    public readonly statusCode?: number,
    public readonly finalUrl?: string
  ) {
    super(message);
    this.name = "HtmlFetchError";
  }
}

export class BrowserFetchError extends Error {
  public constructor(
    message: string,
    public readonly reason: InternalFetchFailureKind,
    public readonly blockedSignals: string[] = [],
    public readonly statusCode?: number,
    public readonly finalUrl?: string
  ) {
    super(message);
    this.name = "BrowserFetchError";
  }
}

export class YouTubeFetchError extends Error {
  public constructor(
    message: string,
    public readonly reason: "unreachable" | "blocked" | "timeout" | "too_large"
  ) {
    super(message);
    this.name = "YouTubeFetchError";
  }
}
