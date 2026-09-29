import React from "react";
import ReactDOM from "react-dom/client";

import { installWebErrorTracking } from "./analytics/client";
import { preloadApiClient } from "./api/client";
import { App } from "./app/App";
import { preloadRouteForPath, warmRouteDataForPath } from "./app/routes";
import { loadExtendedIcons } from "./components/Icon";
import { armBootSettle, whenBootSettled } from "./platform/boot-settle";
import { captureInstallPrompt } from "./platform/install-prompt";
import { installChunkErrorRecovery, setLazyCompanionLoad } from "./platform/lazy";
import "./styles/global.css";

/**
 * How long the first render may wait for the landing page's chunk. The Cookbook's chunk is
 * preloaded next to the entry and is normally ready at once; waiting a moment lets the first
 * render show the page itself rather than a skeleton that is replaced a frame later.
 */
const LANDING_PAGE_WAIT_MS = 120;

// After a deploy, stale tabs may request chunks that no longer exist: reload once to recover.
installChunkErrorRecovery();
// Boot work the first screen doesn't need waits until it is on screen (platform/boot-settle.ts).
armBootSettle();
// Only the Cookbook's icons ship with the shell. Every other page and sheet loads together with
// the rest of the icon set, so none paints with blank icons (see components/Icon.tsx).
setLazyCompanionLoad(loadExtendedIcons);
// The landing page is its own chunk; request it now so it downloads while the shell boots, and
// start reading what it shows first (the Cookbook's recipes) while React renders.
const landingPage = preloadRouteForPath(window.location.pathname);
void warmRouteDataForPath(window.location.pathname);
// Chrome fires `beforeinstallprompt` once, early; capture it before anything renders.
captureInstallPrompt();
installWebErrorTracking();
// Web vitals are measured off the critical path: the observers read buffered entries, so
// starting them a moment later loses nothing, and the page doesn't wait for analytics code. (Not
// held until the page settles: a visit that ends sooner would go unreported.)
void import("./analytics/web-vitals").then(
  (module) => {
    module.startWebVitalsObserver();
  },
  () => undefined
);

whenBootSettled(() => {
  // The API client (and its zod contracts) is a separate chunk: have it ready before the first
  // tap needs it (auth boot requests it on its own when it needs it sooner).
  void preloadApiClient();
  // The rest of the icon set, before menus and sheets ask for it.
  loadExtendedIcons().catch(() => undefined);
});

const renderApp = () => {
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
};

if (landingPage) {
  void Promise.race([
    landingPage,
    new Promise<void>((resolve) => {
      setTimeout(resolve, LANDING_PAGE_WAIT_MS);
    })
  ]).then(renderApp);
} else {
  renderApp();
}
