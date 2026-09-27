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
}

export const ErrorState: React.FC<ErrorStateProps> = ({
  title = "Something went wrong",
  message,
  onRetry,
  retryLabel = "Try again",
  icon = "alert-triangle",
  actions
}) => {
  return (
    <div className="error-container" role="alert">
      <div className="error-icon" aria-hidden="true">
        <Icon name={icon} size={26} />
      </div>
      <h3 className="error-title">{title}</h3>
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
