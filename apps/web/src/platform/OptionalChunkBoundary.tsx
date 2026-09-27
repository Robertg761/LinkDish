import React from "react";

import { trackWebError } from "../analytics/client";

interface OptionalChunkBoundaryProps {
  children: React.ReactNode;
  /** Name used when reporting the failure. */
  name: string;
  /** Called once when the optional UI fails to load or render. */
  onError?: ((error: Error) => void) | undefined;
}

interface OptionalChunkBoundaryState {
  failed: boolean;
}

/**
 * For optional, lazily loaded UI (sheets, prompts) that renders outside the page error boundary:
 * if its chunk can't be loaded or it throws, render nothing instead of taking the app down.
 */
export class OptionalChunkBoundary extends React.Component<
  OptionalChunkBoundaryProps,
  OptionalChunkBoundaryState
> {
  override state: OptionalChunkBoundaryState = { failed: false };

  static getDerivedStateFromError(): OptionalChunkBoundaryState {
    return { failed: true };
  }

  override componentDidCatch(error: Error): void {
    console.warn(`${this.props.name} could not be shown:`, error);
    trackWebError(error, window.location.pathname, "error_boundary");
    this.props.onError?.(error);
  }

  override render(): React.ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}
