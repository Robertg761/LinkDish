import { isIP } from "node:net";

/*
 * A small stand-in for the Public Suffix List, good enough to tell "the same site" apart from
 * "a different site" for redirect and cache checks. Two hosts are the same site when their
 * registrable domain (the label just below the public suffix) matches: www.example.com and
 * example.com, or recipes.example.co.uk and example.co.uk.
 */

/* Second-level labels that ccTLDs use as public suffixes (co.uk, com.au, co.nz, gob.mx...). */
const countrySecondLevelLabels = new Set([
  "ac",
  "co",
  "com",
  "edu",
  "go",
  "gob",
  "gov",
  "govt",
  "ltd",
  "me",
  "net",
  "ne",
  "nic",
  "nom",
  "or",
  "org",
  "plc",
  "sch"
]);

/*
 * Hosting platforms where each subdomain is its own site (PSL "private" suffixes). Recipe
 * blogs commonly live on these, and one blog redirecting to another is a different site.
 */
const sharedHostingSuffixes = new Set([
  "blogspot.com",
  "github.io",
  "netlify.app",
  "pages.dev",
  "squarespace.com",
  "substack.com",
  "tumblr.com",
  "vercel.app",
  "weebly.com",
  "wixsite.com",
  "wordpress.com"
]);

const normalizeHostname = (hostname: string): string =>
  hostname.trim().toLowerCase().replace(/\.+$/u, "");

export const getRegistrableDomain = (hostname: string): string => {
  const host = normalizeHostname(hostname);

  if (host.length === 0 || host.startsWith("[") || isIP(host) !== 0) {
    return host;
  }

  const labels = host.split(".").filter(Boolean);

  if (labels.length <= 2) {
    return labels.join(".");
  }

  const lastTwo = labels.slice(-2).join(".");
  const topLevel = labels[labels.length - 1] ?? "";
  const secondLevel = labels[labels.length - 2] ?? "";

  if (
    sharedHostingSuffixes.has(lastTwo) ||
    (topLevel.length === 2 && countrySecondLevelLabels.has(secondLevel))
  ) {
    return labels.slice(-3).join(".");
  }

  return lastTwo;
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
