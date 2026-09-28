/**
 * Where the first-run sheet may appear. People who arrive through a link (a shared recipe, an
 * invite, a checkout return, the share sheet, a marketing page) came to do something specific,
 * so the sheet never covers that; it waits for a plain visit instead.
 */

export const ONBOARDING_STORAGE_KEY = "linkdish:web:first-run-onboarding-seen:v1";

const DEEP_LINK_PREFIXES = [
  "/featured/",
  "/recipes/shared/",
  "/pricing",
  "/sso-callback",
  "/privacy",
  "/support",
  "/install"
] as const;

export const isOnboardingSuppressedRoute = (pathname: string, search: string): boolean => {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/u, "") : pathname;
  const params = new URLSearchParams(search);

  if (DEEP_LINK_PREFIXES.some((prefix) => path === prefix || path.startsWith(prefix))) {
    return true;
  }

  if (path === "/import") {
    return params.has("url") || params.has("text") || params.has("title");
  }

  if (path === "/household") {
    return params.has("invite");
  }

  if (path === "/account") {
    return params.has("invite") || params.has("upgrade");
  }

  return false;
};
