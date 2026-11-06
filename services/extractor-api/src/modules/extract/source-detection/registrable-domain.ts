import { isIP } from "node:net";

import {
  getRegistrableDomain as getSharedRegistrableDomain,
  normalizeSiteHostname as normalizeHostname
} from "@linkdish/recipe-domain";

export { isKnownLinkShortener } from "@linkdish/recipe-domain";

/*
 * The registrable-domain rules live in @linkdish/recipe-domain so the phone app checks pages the
 * same way. Node's own IP parser still decides what is an address here.
 */

export const getRegistrableDomain = (hostname: string): string => {
  const host = normalizeHostname(hostname);

  return isIP(host) !== 0 ? host : getSharedRegistrableDomain(host);
};

export const isSameRegistrableDomain = (left: string, right: string): boolean =>
  getRegistrableDomain(left) === getRegistrableDomain(right);
