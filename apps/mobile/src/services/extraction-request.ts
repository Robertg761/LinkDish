import type { DevicePage } from "./device-page";
import type { ExtractRecipeRequest, ExtractRecipeResponse } from "@linkdish/api-contracts";

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

/**
 * A link whose site blocks LinkDish's servers, with the page the person opened for it in the
 * in-app browser view. `url` is that page's address.
 */
export interface DevicePageExtractionRequest {
  attempt: "primary" | "fallback";
  correlationId?: string | undefined;
  devicePage: DevicePage;
  url: string;
}

/** Every import this app sends: a link, scans, pasted text, or a page opened on the phone. */
export type MobileExtractionRequest =
  | ExtractRecipeRequest
  | TextExtractionRequest
  | DevicePageExtractionRequest;

export const isDevicePageExtractionRequest = (
  request: MobileExtractionRequest
): request is DevicePageExtractionRequest => "devicePage" in request;

export const isTextExtractionRequest = (
  request: MobileExtractionRequest
): request is TextExtractionRequest => "text" in request;

/**
 * The API could not read a web page because the site blocks its servers, not people: the person
 * can open the page in the app and save it from there.
 */
export const canOpenBlockedPage = (
  request: MobileExtractionRequest,
  response: ExtractRecipeResponse
): boolean =>
  response.status === "failure" &&
  response.reason === "source_blocked" &&
  response.deviceFetchAvailable === true &&
  !isTextExtractionRequest(request) &&
  !isDevicePageExtractionRequest(request) &&
  !("images" in request) &&
  "url" in request &&
  !("inspired" in request && request.inspired);
