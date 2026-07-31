import { useEffect } from "react";
import { useLocation } from "react-router-dom";

import { trackWebEvent } from "./client";

let webAppLoadedTracked = false;

export const RouteAnalytics = () => {
  const location = useLocation();

  useEffect(() => {
    const route = `${location.pathname}${location.search ? "?..." : ""}`;
    const isInitialHomeLoad = location.pathname === "/" && !webAppLoadedTracked;

    if (isInitialHomeLoad) {
      webAppLoadedTracked = true;
    }

    trackWebEvent({
      eventName: isInitialHomeLoad ? "web_app_loaded" : "web_route_viewed",
      routeOrScreen: route,
      properties: {
        route
      }
    });
  }, [location.pathname, location.search]);

  return null;
};
