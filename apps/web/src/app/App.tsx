import { AuthenticateWithRedirectCallback } from "@clerk/clerk-react";
import React, { lazy, Suspense } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";

import { RouteAnalytics } from "../analytics/RouteAnalytics";
import { AppShell } from "../components/AppShell";
import { LoadingState } from "../components/LoadingState";
import { LibraryPage } from "../features/library/LibraryPage";
import { UpgradeSheetProvider } from "../features/upgrade/UpgradeSheet";

import { AppProviders } from "./providers";

const AccountPage = lazy(() =>
  import("../features/account/AccountPage").then((module) => ({ default: module.AccountPage }))
);
const ExtractPage = lazy(() =>
  import("../features/extract/ExtractPage").then((module) => ({ default: module.ExtractPage }))
);
const FeaturedRecipePage = lazy(() =>
  import("../features/featured/FeaturedRecipePage").then((module) => ({
    default: module.FeaturedRecipePage
  }))
);
const HouseholdPage = lazy(() =>
  import("../features/household/HouseholdPage").then((module) => ({
    default: module.HouseholdPage
  }))
);
const InstallPage = lazy(() =>
  import("../features/install/InstallPage").then((module) => ({ default: module.InstallPage }))
);
const RecipePage = lazy(() =>
  import("../features/library/RecipePage").then((module) => ({ default: module.RecipePage }))
);
const PricingPage = lazy(() =>
  import("../features/pricing/PricingPage").then((module) => ({ default: module.PricingPage }))
);
const PrivacyPage = lazy(() =>
  import("../components/PrivacyPage").then((module) => ({ default: module.PrivacyPage }))
);
const ShoppingListPage = lazy(() =>
  import("../features/shopping/ShoppingListPage").then((module) => ({
    default: module.ShoppingListPage
  }))
);
const SupportPage = lazy(() =>
  import("../components/SupportPage").then((module) => ({ default: module.SupportPage }))
);

export const App: React.FC = () => {
  return (
    <AppProviders>
      <BrowserRouter>
        <RouteAnalytics />
        <UpgradeSheetProvider>
          <AppShell>
            <Suspense fallback={<LoadingState message="Loading LinkDish..." />}>
              <Routes>
                <Route path="/" element={<LibraryPage />} />
                <Route path="/featured/:slug" element={<FeaturedRecipePage />} />
                <Route path="/import" element={<ExtractPage />} />
                <Route path="/library" element={<Navigate to="/" replace />} />
                <Route path="/recipes/shared/:sharedId" element={<RecipePage />} />
                <Route path="/recipes/:id" element={<RecipePage />} />
                <Route path="/account" element={<AccountPage />} />
                <Route path="/household" element={<HouseholdPage />} />
                <Route path="/shopping" element={<ShoppingListPage />} />
                <Route path="/pricing" element={<PricingPage />} />
                <Route path="/install" element={<InstallPage />} />
                <Route path="/privacy" element={<PrivacyPage />} />
                <Route path="/support" element={<SupportPage />} />
                <Route path="/sso-callback" element={<AuthenticateWithRedirectCallback />} />

                {/* Catch-all 404 handler redirecting to home */}
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </Suspense>
          </AppShell>
        </UpgradeSheetProvider>
      </BrowserRouter>
    </AppProviders>
  );
};
