import React from "react";
import "./Field.css";

interface FieldProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  inputRef?: React.Ref<HTMLInputElement>;
  rightElement?: React.ReactNode;
}

export const Field: React.FC<FieldProps> = ({
  label,
  error,
  inputRef,
  rightElement,
  id,
  className = "",
  ...props
}) => {
  const inputId =
    id ||
    (label
      ? `field-${label.toLowerCase().replace(/\s+/g, "-")}`
      : `field-${Math.random().toString(36).substring(7)}`);
  const errorId = `${inputId}-error`;

  return (
    <div className={`field-container ${className}`}>
      {label && (
        <label htmlFor={inputId} className="field-label">
          {label}
        </label>
      )}
      <div className="field-input-wrapper">
        <input
          ref={inputRef}
          id={inputId}
          className={`field-input ${error ? "field-input-error" : ""} ${rightElement ? "field-input-with-right" : ""}`}
          aria-invalid={!!error}
          aria-describedby={error ? errorId : undefined}
          {...props}
        />
        {rightElement && <div className="field-right-element">{rightElement}</div>}
      </div>
      {error && (
        <span id={errorId} className="field-error-message" role="alert">
          {error}
        </span>
      )}
    </div>
  );
};
