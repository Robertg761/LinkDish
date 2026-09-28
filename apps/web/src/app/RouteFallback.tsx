import React from "react";

import { LoadingState } from "../components/LoadingState";
import { PageHeader } from "../components/PageHeader";

import type { LoadingStateVariant } from "../components/LoadingState";

import "./RouteFallback.css";

const getVariant = (pathname: string): LoadingStateVariant =>
  pathname.startsWith("/recipes/") || pathname.startsWith("/featured/") ? "recipe" : "page";

/**
 * The Cookbook's frame while its chunk arrives: the same title in the same place, so the real
 * page swaps in without anything jumping.
 */
const CookbookFallback: React.FC = () => (
  <div className="route-fallback-cookbook container-wide" data-route-fallback="">
    <PageHeader
      actions={<span aria-hidden="true" className="route-fallback-tabs skeleton" />}
      className="route-fallback-header"
      subtitle={"\u00a0"}
      title="Cookbook"
    />
    <div aria-hidden="true" className="route-fallback-search skeleton" />
    <LoadingState count={6} message="Opening your cookbook…" variant="grid" />
  </div>
);

/** Suspense fallback for a page chunk that is still loading. */
export const RouteFallback: React.FC<{ pathname: string }> = ({ pathname }) => {
  if (pathname === "/" || pathname === "/library") {
    return <CookbookFallback />;
  }

  return (
    <div data-route-fallback="">
      <LoadingState message="Loading LinkDish..." variant={getVariant(pathname)} />
    </div>
  );
};
