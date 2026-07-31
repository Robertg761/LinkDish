export class FallbackProviderError extends Error {
  public constructor(
    message: string,
    public readonly reason: "fallback_failed" | "quota_exceeded"
  ) {
    super(message);
    this.name = "FallbackProviderError";
  }
}
