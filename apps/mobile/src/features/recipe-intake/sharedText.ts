import { extractFirstUrl } from "@linkdish/recipe-domain";

/**
 * The recipe link inside text shared into the app (a social caption, a message): the first
 * http(s) URL, or a bare "www." link given an https scheme, without trailing punctuation. Uses
 * the domain's extractFirstUrl so the share sheet, the paste field and the web share target
 * all agree on what counts as the link.
 */
export const extractUrlFromSharedText = (value: string | undefined): string | undefined => {
  if (!value) {
    return undefined;
  }

  return extractFirstUrl(value) ?? undefined;
};
