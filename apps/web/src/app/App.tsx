import React, { Suspense, useEffect } from "react";
import { BrowserRouter, Routes, Route, Navigate, useLocation } from "react-router-dom";

import { RouteAnalytics } from "../analytics/RouteAnalytics";
import { getAppRouteMeta } from "../components/app-route-meta";
import { AppShell } from "../components/AppShell";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { ToastProvider } from "../components/Toast";
import { CommandCenter } from "../features/command-palette/CommandCenter";
import { UpgradeSheetProvider } from "../features/upgrade/UpgradeSheet";
import { formatDocumentTitle } from "../lib/use-document-title";
import { initPreferences } from "../preferences/preferences-store";

import { AppUpdatePrompt } from "./AppUpdatePrompt";
import { AppProviders } from "./providers";
import { RouteFallback } from "./RouteFallback";
import {
  AccountPage,
  ExtractPage,
  FeaturedRecipePage,
  HouseholdPage,
  InstallPage,
  LibraryPage,
  PlanPage,
  PricingPage,
  PrivacyPage,
  RecipePage,
  SettingsPage,
  ShoppingListPage,
  SsoCallbackPage,
  SupportPage
} from "./routes";
import { ScrollManager } from "./ScrollManager";

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

const AppRoutes: React.FC = () => {
  const location = useLocation();

  return (
    // Keyed by route so navigating away from a broken page clears the fallback.
    <ErrorBoundary key={location.pathname}>
      <Suspense fallback={<RouteFallback pathname={location.pathname} />}>
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
          <Route path="/sso-callback" element={<SsoCallbackPage />} />

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
    <BrowserRouter>
      <AppProviders>
        <RouteAnalytics />
        <ScrollManager />
        <RouteDocumentTitle />
        <ToastProvider>
          <UpgradeSheetProvider>
            <AppShell>
              <AppRoutes />
            </AppShell>
            <CommandCenter />
            <AppUpdatePrompt />
          </UpgradeSheetProvider>
        </ToastProvider>
      </AppProviders>
    </BrowserRouter>
  );
};
