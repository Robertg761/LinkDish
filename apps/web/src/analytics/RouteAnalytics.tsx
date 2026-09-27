import { useEffect } from "react";
import { useLocation } from "react-router-dom";

import { trackWebEvent } from "./client";

let webAppLoadedTracked = false;

/** Test seam: forget that this page load already reported `web_app_loaded`. */
export const resetRouteAnalyticsForTests = (): void => {
  webAppLoadedTracked = false;
};

/**
 * Reports `web_app_loaded` once per page load, for whichever route the visit starts on (deep
 * links, share targets and featured pages included), and `web_route_viewed` for every route view
 * except an initial landing on the home route — the same route-view counts as before.
 */
export const RouteAnalytics = () => {
  const location = useLocation();

  useEffect(() => {
    const route = `${location.pathname}${location.search ? "?..." : ""}`;
    const isInitialLoad = !webAppLoadedTracked;
    webAppLoadedTracked = true;

    if (isInitialLoad) {
      trackWebEvent({
        eventName: "web_app_loaded",
        routeOrScreen: route,
        properties: {
          route
        }
      });
    }

    if (!isInitialLoad || location.pathname !== "/") {
      trackWebEvent({
        eventName: "web_route_viewed",
        routeOrScreen: route,
        properties: {
          route
        }
      });
    }
  }, [location.pathname, location.search]);

  return null;
};
