import { lazyWithRetry } from "../platform/lazy";

/**
 * Every page is its own chunk, so the entry bundle holds only the shell. The page for the URL
 * the visit starts on is requested from main.tsx before React renders (see
 * {@link preloadRouteForPath}), so its download overlaps the entry's instead of following it;
 * the Cookbook's chunk is also preloaded from index.html (vite.config.ts).
 */

// The landing page uses only core icons, so it never waits for the extended set.
export const LibraryPage = lazyWithRetry(
  () =>
    import("../features/library/LibraryPage").then((module) => ({ default: module.LibraryPage })),
  { standalone: true }
);
export const AccountPage = lazyWithRetry(() =>
  import("../features/account/AccountPage").then((module) => ({ default: module.AccountPage }))
);
export const ExtractPage = lazyWithRetry(() =>
  import("../features/extract/ExtractPage").then((module) => ({ default: module.ExtractPage }))
);
export const FeaturedRecipePage = lazyWithRetry(() =>
  import("../features/featured/FeaturedRecipePage").then((module) => ({
    default: module.FeaturedRecipePage
  }))
);
export const HouseholdPage = lazyWithRetry(() =>
  import("../features/household/HouseholdPage").then((module) => ({
    default: module.HouseholdPage
  }))
);
export const InstallPage = lazyWithRetry(() =>
  import("../features/install/InstallPage").then((module) => ({ default: module.InstallPage }))
);
export const PlanPage = lazyWithRetry(() =>
  import("../features/plan/PlanPage").then((module) => ({ default: module.PlanPage }))
);
export const RecipePage = lazyWithRetry(() =>
  import("../features/library/RecipePage").then((module) => ({ default: module.RecipePage }))
);
export const PricingPage = lazyWithRetry(() =>
  import("../features/pricing/PricingPage").then((module) => ({ default: module.PricingPage }))
);
export const PrivacyPage = lazyWithRetry(() =>
  import("../components/PrivacyPage").then((module) => ({ default: module.PrivacyPage }))
);
export const SettingsPage = lazyWithRetry(() =>
  import("../features/settings/SettingsPage").then((module) => ({
    default: module.SettingsPage
  }))
);
export const ShoppingListPage = lazyWithRetry(() =>
  import("../features/shopping/ShoppingListPage").then((module) => ({
    default: module.ShoppingListPage
  }))
);
export const SsoCallbackPage = lazyWithRetry(() =>
  import("./SsoCallbackPage").then((module) => ({ default: module.SsoCallbackPage }))
);
export const SupportPage = lazyWithRetry(() =>
  import("../components/SupportPage").then((module) => ({ default: module.SupportPage }))
);

const normalizePath = (pathname: string): string =>
  pathname.length > 1 ? pathname.replace(/\/+$/u, "") : pathname;

const isCookbookPath = (path: string): boolean => path === "/" || path === "/library";

/** The page a URL lands on, for the routes people most often start from. */
const BOOT_ROUTES: ReadonlyArray<{
  match: (path: string) => boolean;
  page: { preload: () => Promise<void> };
}> = [
  { match: isCookbookPath, page: LibraryPage },
  { match: (path) => path.startsWith("/recipes/"), page: RecipePage },
  { match: (path) => path.startsWith("/featured/"), page: FeaturedRecipePage },
  { match: (path) => path === "/import", page: ExtractPage },
  { match: (path) => path === "/plan", page: PlanPage },
  { match: (path) => path === "/shopping", page: ShoppingListPage },
  { match: (path) => path === "/account", page: AccountPage }
];

/**
 * Starts loading the page chunk for `pathname` (the landing URL) right away, before React
 * renders. Resolves once it has loaded (a loaded page renders without a Suspense fallback) and
 * never rejects: a failure is left for the page's own lazy import (with its retries and error
 * boundary) to surface. Returns null for routes without a boot preload.
 */
export const preloadRouteForPath = (pathname: string): Promise<void> | null => {
  const path = normalizePath(pathname);
  const route = BOOT_ROUTES.find((entry) => entry.match(path));

  return route ? route.page.preload().catch(() => undefined) : null;
};

/**
 * Starts reading the data the landing page shows first, alongside its chunk: IndexedDB answers
 * while the shell renders, instead of only once the page has mounted. Only the Cookbook reads
 * storage before its first meaningful paint. Resolves when the read has settled (never rejects);
 * null for other routes.
 */
export const warmRouteDataForPath = (pathname: string): Promise<void> | null =>
  isCookbookPath(normalizePath(pathname))
    ? import("../features/library/LibraryPage").then(
        (module) => module.warmCookbook(),
        () => undefined
      )
    : null;
