import React from "react";
import ReactDOM from "react-dom/client";

import { installWebErrorTracking } from "./analytics/client";
import { startWebVitalsObserver } from "./analytics/web-vitals";
import { preloadApiClient } from "./api/client";
import { App } from "./app/App";
import { captureInstallPrompt } from "./platform/install-prompt";
import { installChunkErrorRecovery } from "./platform/lazy";
import "./styles/global.css";

// After a deploy, stale tabs may request chunks that no longer exist: reload once to recover.
installChunkErrorRecovery();
// Chrome fires `beforeinstallprompt` once, early; capture it before anything renders.
captureInstallPrompt();
installWebErrorTracking();
// The API client (and its zod contracts) is a separate chunk; start fetching it while React
// renders so auth boot does not wait on a request waterfall.
void preloadApiClient();
startWebVitalsObserver();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
