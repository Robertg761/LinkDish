import React from "react";

import { Skeleton, SkeletonText } from "./Skeleton";

import "./LoadingState.css";

export type LoadingStateVariant = "spinner" | "page" | "list" | "grid" | "recipe";

interface LoadingStateProps {
  message?: React.ReactNode;
  /**
   * spinner = centered spinner + message; the others draw skeletons shaped like the
   * content that is coming (message is kept for screen readers).
   */
  variant?: LoadingStateVariant | undefined;
  /** Rows / cards to draw for the list and grid variants. */
  count?: number | undefined;
}

const ListSkeleton: React.FC<{ count: number }> = ({ count }) => (
  <div className="loading-skeleton-list">
    {Array.from({ length: count }, (_, index) => (
      <div className="loading-skeleton-row" key={index}>
        <Skeleton width={72} height={72} radius={16} />
        <div className="loading-skeleton-row-copy">
          <Skeleton shape="text" width="70%" height={18} />
          <Skeleton shape="text" width="45%" />
        </div>
      </div>
    ))}
  </div>
);

const GridSkeleton: React.FC<{ count: number }> = ({ count }) => (
  <div className="loading-skeleton-grid">
    {Array.from({ length: count }, (_, index) => (
      <div className="loading-skeleton-card" key={index}>
        <Skeleton className="loading-skeleton-card-image" radius={0} />
        <div className="loading-skeleton-card-copy">
          <Skeleton shape="text" width="80%" height={16} />
          <Skeleton shape="text" width="50%" />
        </div>
      </div>
    ))}
  </div>
);

const RecipeSkeleton = () => (
  <div className="loading-skeleton-recipe">
    <Skeleton className="loading-skeleton-hero" radius={24} />
    <Skeleton shape="text" width="75%" height={34} />
    <Skeleton shape="text" width="45%" />
    <div className="loading-skeleton-chips">
      <Skeleton width={84} height={36} radius={999} />
      <Skeleton width={84} height={36} radius={999} />
      <Skeleton width={84} height={36} radius={999} />
    </div>
    <SkeletonText lines={4} />
  </div>
);

const PageSkeleton = () => (
  <div className="loading-skeleton-page">
    <Skeleton shape="text" width="46%" height={40} />
    <Skeleton shape="text" width="68%" />
    <Skeleton className="loading-skeleton-block" radius={20} />
    <ListSkeleton count={3} />
  </div>
);

export const LoadingState: React.FC<LoadingStateProps> = ({
  message = "Loading...",
  variant = "spinner",
  count
}) => {
  if (variant === "spinner") {
    return (
      <div className="loading-container" aria-live="polite" role="status">
        <div className="spinner large"></div>
        <p className="loading-message">{message}</p>
      </div>
    );
  }

  return (
    <div
      aria-busy="true"
      aria-live="polite"
      className={`loading-skeleton loading-skeleton-${variant}-wrap`}
      role="status"
    >
      <span className="sr-only">{message}</span>
      {variant === "list" ? <ListSkeleton count={count ?? 5} /> : null}
      {variant === "grid" ? <GridSkeleton count={count ?? 6} /> : null}
      {variant === "recipe" ? <RecipeSkeleton /> : null}
      {variant === "page" ? <PageSkeleton /> : null}
    </div>
  );
};
