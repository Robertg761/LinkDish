import type { ExtractRecipeRequest } from "@linkdish/api-contracts";

/**
 * Pasted recipe text. `routeUrl` keys the import on this device (the route, the draft); only the
 * caption's own link (`sourceUrl`) is sent, and without one the API makes up the recipe's source.
 */
export interface TextExtractionRequest {
  attempt: "primary" | "fallback";
  correlationId?: string | undefined;
  routeUrl: string;
  sourceUrl?: string | undefined;
  text: string;
}

/** Every import this app sends: a link, scans, or pasted text. */
export type MobileExtractionRequest = ExtractRecipeRequest | TextExtractionRequest;

export const isTextExtractionRequest = (
  request: MobileExtractionRequest
): request is TextExtractionRequest => "text" in request;
