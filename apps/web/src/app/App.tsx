import { AuthenticateWithRedirectCallback } from "@clerk/clerk-react";
import React, { Suspense, useEffect } from "react";
import { BrowserRouter, Routes, Route, Navigate, useLocation } from "react-router-dom";

import { RouteAnalytics } from "../analytics/RouteAnalytics";
import { getAppRouteMeta } from "../components/app-route-meta";
import { AppShell } from "../components/AppShell";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { LoadingState } from "../components/LoadingState";
import { ToastProvider } from "../components/Toast";
import { LibraryPage } from "../features/library/LibraryPage";
import { UpgradeSheetProvider } from "../features/upgrade/UpgradeSheet";
import { formatDocumentTitle } from "../lib/use-document-title";
import { lazyWithRetry } from "../platform/lazy";
import { initPreferences } from "../preferences/preferences-store";

import { AppProviders } from "./providers";
import { ScrollManager } from "./ScrollManager";

import type { LoadingStateVariant } from "../components/LoadingState";

const AccountPage = lazyWithRetry(() =>
  import("../features/account/AccountPage").then((module) => ({ default: module.AccountPage }))
);
const ExtractPage = lazyWithRetry(() =>
  import("../features/extract/ExtractPage").then((module) => ({ default: module.ExtractPage }))
);
const FeaturedRecipePage = lazyWithRetry(() =>
  import("../features/featured/FeaturedRecipePage").then((module) => ({
    default: module.FeaturedRecipePage
  }))
);
const HouseholdPage = lazyWithRetry(() =>
  import("../features/household/HouseholdPage").then((module) => ({
    default: module.HouseholdPage
  }))
);
const InstallPage = lazyWithRetry(() =>
  import("../features/install/InstallPage").then((module) => ({ default: module.InstallPage }))
);
const PlanPage = lazyWithRetry(() =>
  import("../features/plan/PlanPage").then((module) => ({ default: module.PlanPage }))
);
const RecipePage = lazyWithRetry(() =>
  import("../features/library/RecipePage").then((module) => ({ default: module.RecipePage }))
);
const PricingPage = lazyWithRetry(() =>
  import("../features/pricing/PricingPage").then((module) => ({ default: module.PricingPage }))
);
const PrivacyPage = lazyWithRetry(() =>
  import("../components/PrivacyPage").then((module) => ({ default: module.PrivacyPage }))
);
const SettingsPage = lazyWithRetry(() =>
  import("../features/settings/SettingsPage").then((module) => ({
    default: module.SettingsPage
  }))
);
const ShoppingListPage = lazyWithRetry(() =>
  import("../features/shopping/ShoppingListPage").then((module) => ({
    default: module.ShoppingListPage
  }))
);
const SupportPage = lazyWithRetry(() =>
  import("../components/SupportPage").then((module) => ({ default: module.SupportPage }))
);

/**
 * Sets a sensible document.title for every route. It renders before the routes, so
 * its effect runs first and a page's own useDocumentTitle (e.g. the recipe name) wins.
 */
const RouteDocumentTitle: React.FC = () => {
  const { pathname } = useLocation();

  useEffect(() => {
    document.title = formatDocumentTitle(getAppRouteMeta(pathname).title);
  }, [pathname]);

  return null;
};

const getSuspenseVariant = (pathname: string): LoadingStateVariant =>
  pathname.startsWith("/recipes/") || pathname.startsWith("/featured/") ? "recipe" : "page";

const AppRoutes: React.FC = () => {
  const location = useLocation();

  return (
    // Keyed by route so navigating away from a broken page clears the fallback.
    <ErrorBoundary key={location.pathname}>
      <Suspense
        fallback={
          <LoadingState
            message="Loading LinkDish..."
            variant={getSuspenseVariant(location.pathname)}
          />
        }
      >
        <Routes>
          <Route path="/" element={<LibraryPage />} />
          <Route path="/featured/:slug" element={<FeaturedRecipePage />} />
          <Route path="/import" element={<ExtractPage />} />
          <Route path="/library" element={<Navigate to="/" replace />} />
          <Route path="/plan" element={<PlanPage />} />
          <Route path="/recipes/shared/:sharedId" element={<RecipePage />} />
          <Route path="/recipes/:id" element={<RecipePage />} />
          <Route path="/account" element={<AccountPage />} />
          <Route path="/household" element={<HouseholdPage />} />
          <Route path="/shopping" element={<ShoppingListPage />} />
          <Route path="/pricing" element={<PricingPage />} />
          <Route path="/install" element={<InstallPage />} />
          <Route path="/privacy" element={<PrivacyPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/support" element={<SupportPage />} />
          <Route path="/sso-callback" element={<AuthenticateWithRedirectCallback />} />

          {/* Catch-all 404 handler redirecting to home */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </ErrorBoundary>
  );
};

export const App: React.FC = () => {
  useEffect(() => {
    // index.html already applied the stored theme before first paint; this keeps
    // <html data-theme> in sync afterwards and across tabs.
    initPreferences();
  }, []);

  return (
    <AppProviders>
      <BrowserRouter>
        <RouteAnalytics />
        <ScrollManager />
        <RouteDocumentTitle />
        <ToastProvider>
          <UpgradeSheetProvider>
            <AppShell>
              <AppRoutes />
            </AppShell>
          </UpgradeSheetProvider>
        </ToastProvider>
      </BrowserRouter>
    </AppProviders>
  );
};
