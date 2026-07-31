import React from "react";
import "./LoadingState.css";

interface LoadingStateProps {
  message?: React.ReactNode;
}

export const LoadingState: React.FC<LoadingStateProps> = ({
  message = "Loading..."
}) => {
  return (
    <div className="loading-container" aria-live="polite" role="status">
      <div className="spinner large"></div>
      <p className="loading-message">{message}</p>
    </div>
  );
};
