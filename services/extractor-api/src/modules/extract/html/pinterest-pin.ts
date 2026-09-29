import { httpUrlSchema } from "../../../../../../packages/recipe-domain/src/index.js";
import { isPinterestHostUrl } from "../source-detection/detect-source-from-url.js";

import { findJsonStringValues } from "./json-string-literal.js";
import { getParsedHtmlDocument } from "./parsed-html-document.js";

import type { HtmlSourceDocument } from "../types.js";

/*
 * A Pinterest pin page is a picture plus a link to where the recipe actually lives. Pinterest
 * publishes that link as og:see_also, and the pin's app state carries it as "link". The link
 * is only followed when it is an ordinary http(s) page outside Pinterest that is valid as a
 * recipe's sourceUrl (it becomes one); the caller still runs it through URL safety validation
 * before fetching.
 */
const isFollowableOutboundUrl = (value: string | null | undefined): value is string => {
  const candidate = value?.trim();
  return Boolean(
    candidate && httpUrlSchema.safeParse(candidate).success && !isPinterestHostUrl(candidate)
  );
};

export const findPinterestOutboundUrl = (document: HtmlSourceDocument): string | null => {
  const parsed = getParsedHtmlDocument(document);
  const metaCandidates = [
    parsed.metaContent("property", "og:see_also"),
    parsed.metaContent("name", "og:see_also")
  ];

  for (const candidate of metaCandidates) {
    if (isFollowableOutboundUrl(candidate)) {
      return candidate.trim();
    }
  }

  for (const key of ["link", "tracked_link"]) {
    const outbound = findJsonStringValues(document.html, key).find(isFollowableOutboundUrl);

    if (outbound) {
      return outbound.trim();
    }
  }

  return null;
};
