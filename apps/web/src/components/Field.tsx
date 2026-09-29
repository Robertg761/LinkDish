import React, { useCallback, useId, useRef } from "react";

import { Icon } from "./Icon";
import { useAutosizeTextarea } from "./use-autosize-textarea";

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
  /**
   * Grow with the text instead of scrolling inside a fixed box (no resize grip). With
   * `singleLine`, it starts as tall as a text input and never takes a line break (a long title
   * wraps instead of being cut off).
   */
  autoGrow?: boolean | undefined;
  singleLine?: boolean | undefined;
}

export const TextAreaField: React.FC<TextAreaFieldProps> = ({
  label,
  error,
  hint,
  textareaRef,
  id,
  className = "",
  rows = 4,
  autoGrow = false,
  singleLine = false,
  onChange,
  onKeyDown,
  ...props
}) => {
  const generatedId = useId();
  const inputId = id || `field-${generatedId}`;
  const errorId = `${inputId}-error`;
  const hintId = `${inputId}-hint`;
  const innerRef = useRef<HTMLTextAreaElement | null>(null);
  const setRef = useCallback(
    (element: HTMLTextAreaElement | null) => {
      innerRef.current = element;

      if (typeof textareaRef === "function") {
        textareaRef(element);
      } else if (textareaRef) {
        textareaRef.current = element;
      }
    },
    [textareaRef]
  );
  const grows = autoGrow || singleLine;

  useAutosizeTextarea(innerRef, String(props.value ?? ""), grows);

  return (
    <div className={`field-container ${className}`.trim()}>
      {label && (
        <label htmlFor={inputId} className="field-label">
          {label}
        </label>
      )}
      <textarea
        ref={setRef}
        id={inputId}
        rows={singleLine ? 1 : rows}
        className={[
          "field-input",
          "field-textarea",
          grows ? "is-auto-grow" : "",
          singleLine ? "is-single-line" : "",
          error ? "field-input-error" : ""
        ]
          .filter(Boolean)
          .join(" ")}
        aria-invalid={!!error}
        aria-describedby={error ? errorId : hint ? hintId : undefined}
        onChange={(event) => {
          if (singleLine && /[\r\n]/u.test(event.target.value)) {
            event.target.value = event.target.value.replace(/[\r\n]+/gu, " ");
          }

          onChange?.(event);
        }}
        onKeyDown={(event) => {
          if (singleLine && event.key === "Enter") {
            event.preventDefault();
          }

          onKeyDown?.(event);
        }}
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
