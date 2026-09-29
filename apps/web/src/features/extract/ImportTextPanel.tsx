import React, { useEffect, useId, useRef, useState } from "react";

import { Button } from "../../components/Button";
import { Icon } from "../../components/Icon";

import {
  findCaptionSourceUrl,
  getTextInputProblem,
  MAX_IMPORT_TEXT_CHARS,
  measureImportText,
  MIN_IMPORT_TEXT_CHARS,
  parseLinkList
} from "./import-input";

interface ImportTextPanelProps {
  value: string;
  onChange: (value: string) => void;
  focusRequest?: number | undefined;
  disabled?: boolean | undefined;
  onImport: (text: string, options: { sourceUrl?: string | undefined }) => void;
  /** The "text" is really just a link: import it as one. */
  onImportLink: (url: string) => void;
}

const numberFormat = new Intl.NumberFormat();

/** A caption, a note or an email with a recipe in it: AI help turns it into a recipe card. */
export const ImportTextPanel: React.FC<ImportTextPanelProps> = ({
  value,
  onChange,
  focusRequest,
  disabled = false,
  onImport,
  onImportLink
}) => {
  const fieldId = useId();
  const counterId = useId();
  const errorId = useId();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [showError, setShowError] = useState(false);
  const length = measureImportText(value);
  const problem = getTextInputProblem(value);
  const links = parseLinkList(value);
  const onlyALink = links.length === 1 && value.trim().length <= (links[0]?.length ?? 0) + 12;

  useEffect(() => {
    if (focusRequest) {
      textareaRef.current?.focus();
    }
  }, [focusRequest]);

  // Grows with the pasted recipe (up to a comfortable height), so nothing hides above the fold.
  useEffect(() => {
    const element = textareaRef.current;

    if (!element) {
      return;
    }

    element.style.height = "";
    const natural = element.scrollHeight;

    if (natural > element.clientHeight) {
      element.style.height = `${Math.min(natural + 2, 440)}px`;
    }
  }, [value]);

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();

    if (disabled) {
      return;
    }

    if (onlyALink && links[0]) {
      onImportLink(links[0]);
      return;
    }

    if (problem) {
      setShowError(true);
      textareaRef.current?.focus();
      return;
    }

    // A caption that includes its post's link keeps that link as the recipe's source.
    const sourceUrl = findCaptionSourceUrl(value);
    onImport(value, sourceUrl ? { sourceUrl } : {});
  };

  const errorText =
    problem === "too_long"
      ? `That's a lot of text. Trim it to ${numberFormat.format(MAX_IMPORT_TEXT_CHARS)} characters or fewer.`
      : length === 0
        ? "Paste the recipe text first."
        : `Add a little more: at least ${MIN_IMPORT_TEXT_CHARS} characters, ideally the ingredients and the steps.`;

  return (
    <form className="import-text" noValidate onSubmit={handleSubmit}>
      <label className="import-text-label" htmlFor={fieldId}>
        Recipe text
      </label>
      <div className={`import-text-box${showError && problem ? " has-error" : ""}`}>
        <textarea
          aria-describedby={[counterId, showError && problem ? errorId : ""]
            .filter(Boolean)
            .join(" ")}
          aria-invalid={showError && Boolean(problem)}
          className="import-text-input"
          disabled={disabled}
          id={fieldId}
          maxLength={MAX_IMPORT_TEXT_CHARS + 2_000}
          onChange={(event) => {
            onChange(event.target.value);
            setShowError(false);
          }}
          placeholder={
            "Paste a recipe from a caption, a note or an email.\n\nIngredients and steps are all we need."
          }
          ref={textareaRef}
          rows={8}
          value={value}
        />
        <div className="import-text-meta">
          <span className="import-text-tip">Read with AI help</span>
          <span
            aria-live="polite"
            className={`import-text-counter num${problem === "too_long" ? " is-over" : ""}`}
            id={counterId}
          >
            {numberFormat.format(length)} / {numberFormat.format(MAX_IMPORT_TEXT_CHARS)}
          </span>
        </div>
      </div>

      {showError && problem ? (
        <p className="import-link-error" id={errorId} role="alert">
          <Icon name="alert-circle" size={16} />
          {errorText}
        </p>
      ) : onlyALink ? (
        <p className="import-link-hint is-batch">
          <Icon name="link" size={16} />
          That’s a link. We’ll import it as one.
        </p>
      ) : null}

      <Button
        className="import-text-submit"
        disabled={disabled}
        fullWidth
        size="lg"
        trailingIcon="arrow-right"
        type="submit"
        variant="accent"
      >
        Get the recipe
      </Button>
    </form>
  );
};
