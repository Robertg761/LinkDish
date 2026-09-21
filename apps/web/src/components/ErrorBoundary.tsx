import React from "react";

import { Button } from "./Button";
import "./ErrorBoundary.css";

interface ErrorBoundaryProps {
  children: React.ReactNode;
  /** Called when the user asks to retry, e.g. to re-run a failed load. */
  onReset?: (() => void) | undefined;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Catches render-time errors below it. `<Suspense>` only handles pending
 * promises, so without this a single throw during render unmounts the whole
 * tree and leaves a blank page.
 */
export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    console.error("Unhandled render error:", error, errorInfo.componentStack);
  }

  private handleRetry = (): void => {
    this.setState({ error: null });
    this.props.onReset?.();
  };

  private handleReload = (): void => {
    window.location.reload();
  };

  override render(): React.ReactNode {
    if (!this.state.error) {
      return this.props.children;
    }

    return (
      <div className="app-error-boundary" role="alert">
        <div aria-hidden="true" className="app-error-boundary-icon">
          ⚠️
        </div>
        <h1 className="app-error-boundary-title">Something went wrong</h1>
        <p className="app-error-boundary-message">
          This page stopped responding. Your saved recipes are still on this device - try again, or
          reload LinkDish.
        </p>
        <div className="app-error-boundary-actions">
          <Button onClick={this.handleRetry} variant="primary">
            Try again
          </Button>
          <Button onClick={this.handleReload} variant="outline">
            Reload LinkDish
          </Button>
        </div>
      </div>
    );
  }
}
