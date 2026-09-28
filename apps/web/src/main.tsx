import React from "react";
import ReactDOM from "react-dom/client";

import { installWebErrorTracking } from "./analytics/client";
import { startWebVitalsObserver } from "./analytics/web-vitals";
import { preloadApiClient } from "./api/client";
import { App } from "./app/App";
import { preloadRouteForPath } from "./app/routes";
import { captureInstallPrompt } from "./platform/install-prompt";
import { installChunkErrorRecovery } from "./platform/lazy";
import "./styles/global.css";

/**
 * How long the first render may wait for the landing page's chunk. The Cookbook's chunk is
 * preloaded next to the entry and is normally ready at once; waiting a moment lets the first
 * render show the page itself rather than a skeleton that is replaced a frame later.
 */
const LANDING_PAGE_WAIT_MS = 120;

// After a deploy, stale tabs may request chunks that no longer exist: reload once to recover.
installChunkErrorRecovery();
// The landing page is its own chunk; request it now so it downloads while the shell boots.
const landingPage = preloadRouteForPath(window.location.pathname);
// Chrome fires `beforeinstallprompt` once, early; capture it before anything renders.
captureInstallPrompt();
installWebErrorTracking();
// The API client (and its zod contracts) is a separate chunk; start fetching it while React
// renders so auth boot does not wait on a request waterfall.
void preloadApiClient();
startWebVitalsObserver();

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
