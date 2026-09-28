import React from "react";

import { Button } from "./Button";
import { Icon } from "./Icon";

import type { IconName } from "./Icon";

import "./ErrorState.css";

interface ErrorStateProps {
  title?: string | undefined;
  message: string;
  onRetry?: (() => void) | undefined;
  retryLabel?: string | undefined;
  icon?: IconName | undefined;
  /** Extra actions next to the retry button. */
  actions?: React.ReactNode;
  /** 1 when the error is the whole page, so it has the page's main heading. */
  headingLevel?: 1 | 2 | 3 | undefined;
}

export const ErrorState: React.FC<ErrorStateProps> = ({
  title = "Something went wrong",
  message,
  onRetry,
  retryLabel = "Try again",
  icon = "alert-triangle",
  actions,
  headingLevel = 3
}) => {
  const Heading = headingLevel === 1 ? "h1" : headingLevel === 2 ? "h2" : "h3";

  return (
    <div className="error-container" role="alert">
      <div className="error-icon" aria-hidden="true">
        <Icon name={icon} size={26} />
      </div>
      <Heading className="error-title">{title}</Heading>
      <p className="error-message">{message}</p>
      {onRetry || actions ? (
        <div className="error-actions">
          {onRetry && (
            <Button icon="refresh" variant="secondary" onClick={onRetry}>
              {retryLabel}
            </Button>
          )}
          {actions}
        </div>
      ) : null}
    </div>
  );
};
