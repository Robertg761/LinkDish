import React from "react";
import ReactDOM from "react-dom/client";

import { installWebErrorTracking } from "./analytics/client";
import { App } from "./app/App";
import "./styles/global.css";

installWebErrorTracking();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
