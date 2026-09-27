import React, { useId } from "react";

import { Icon } from "./Icon";

import type { IconName } from "./Icon";

import "./Field.css";

interface FieldProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string | undefined;
  error?: string | undefined;
  /** Helper text shown under the input (replaced by the error when there is one). */
  hint?: React.ReactNode;
  inputRef?: React.Ref<HTMLInputElement> | undefined;
  /** Icon inside the input, before the text. */
  leadingIcon?: IconName | undefined;
  rightElement?: React.ReactNode;
}

/**
 * Labeled text input. Ids come from `useId`, so two fields with the same label on
 * one page never share an id (that used to cross-wire htmlFor/aria-describedby).
 */
export const Field: React.FC<FieldProps> = ({
  label,
  error,
  hint,
  inputRef,
  leadingIcon,
  rightElement,
  id,
  className = "",
  "aria-describedby": ariaDescribedBy,
  ...props
}) => {
  const generatedId = useId();
  const inputId = id || `field-${generatedId}`;
  const errorId = `${inputId}-error`;
  const hintId = `${inputId}-hint`;
  const describedBy =
    [ariaDescribedBy, error ? errorId : hint ? hintId : undefined].filter(Boolean).join(" ") ||
    undefined;

  return (
    <div className={`field-container ${className}`.trim()}>
      {label && (
        <label htmlFor={inputId} className="field-label">
          {label}
        </label>
      )}
      <div className="field-input-wrapper">
        {leadingIcon ? <Icon name={leadingIcon} size={18} className="field-leading-icon" /> : null}
        <input
          ref={inputRef}
          id={inputId}
          className={[
            "field-input",
            error ? "field-input-error" : "",
            rightElement ? "field-input-with-right" : "",
            leadingIcon ? "field-input-with-leading" : ""
          ]
            .filter(Boolean)
            .join(" ")}
          aria-invalid={!!error}
          aria-describedby={describedBy}
          {...props}
        />
        {rightElement && <div className="field-right-element">{rightElement}</div>}
      </div>
      {error ? (
        <span id={errorId} className="field-error-message" role="alert">
          <Icon name="alert-circle" size={15} />
          {error}
        </span>
      ) : hint ? (
        <span id={hintId} className="field-hint">
          {hint}
        </span>
      ) : null}
    </div>
  );
};

/** Alias with the design-system name; identical to Field. */
export const TextField = Field;

interface TextAreaFieldProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string | undefined;
  error?: string | undefined;
  hint?: React.ReactNode;
  textareaRef?: React.Ref<HTMLTextAreaElement> | undefined;
}

export const TextAreaField: React.FC<TextAreaFieldProps> = ({
  label,
  error,
  hint,
  textareaRef,
  id,
  className = "",
  rows = 4,
  ...props
}) => {
  const generatedId = useId();
  const inputId = id || `field-${generatedId}`;
  const errorId = `${inputId}-error`;
  const hintId = `${inputId}-hint`;

  return (
    <div className={`field-container ${className}`.trim()}>
      {label && (
        <label htmlFor={inputId} className="field-label">
          {label}
        </label>
      )}
      <textarea
        ref={textareaRef}
        id={inputId}
        rows={rows}
        className={`field-input field-textarea${error ? " field-input-error" : ""}`}
        aria-invalid={!!error}
        aria-describedby={error ? errorId : hint ? hintId : undefined}
        {...props}
      />
      {error ? (
        <span id={errorId} className="field-error-message" role="alert">
          <Icon name="alert-circle" size={15} />
          {error}
        </span>
      ) : hint ? (
        <span id={hintId} className="field-hint">
          {hint}
        </span>
      ) : null}
    </div>
  );
};
