import { isIP } from "node:net";

import {
  getRegistrableDomain as getSharedRegistrableDomain,
  normalizeSiteHostname as normalizeHostname
} from "@linkdish/recipe-domain";

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

/*
 * Link shorteners and link-in-bio pages. Their whole job is to send people to another site,
 * so a cross-site redirect from them is expected rather than a sign of a moved recipe.
 */
const linkShortenerHosts = new Set([
  "bit.ly",
  "buff.ly",
  "cutt.ly",
  "dlvr.it",
  "is.gd",
  "linktr.ee",
  "lnkd.in",
  "ow.ly",
  "pin.it",
  "rebrand.ly",
  "shorturl.at",
  "t.co",
  "tiny.cc",
  "tinyurl.com",
  "trib.al"
]);

export const isKnownLinkShortener = (hostname: string): boolean => {
  const host = normalizeHostname(hostname).replace(/^www\./u, "");
  return linkShortenerHosts.has(host);
};
