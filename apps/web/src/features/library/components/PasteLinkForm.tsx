import { extractFirstUrl } from "@linkdish/recipe-domain";
import React, { useId, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { Button } from "../../../components/Button";
import { Icon } from "../../../components/Icon";

import { buildImportPath } from "./library-model";

import "./PasteLinkForm.css";

const canReadClipboard = (): boolean =>
  typeof navigator !== "undefined" && typeof navigator.clipboard?.readText === "function";

interface PasteLinkFormProps {
  /** Visible label above the field; also its accessible name. */
  label?: string | undefined;
}

/**
 * "Paste a link. Get cooking." A link field that opens the importer with the URL, plus a Paste
 * button that reads the clipboard (and imports straight away when it holds a link).
 */
export const PasteLinkForm: React.FC<PasteLinkFormProps> = ({ label = "Recipe link" }) => {
  const navigate = useNavigate();
  const inputId = useId();
  const errorId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const clipboardAvailable = canReadClipboard();

  const openImporter = (text: string): boolean => {
    const url = extractFirstUrl(text);

    if (!url) {
      return false;
    }

    void navigate(buildImportPath(url));
    return true;
  };

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!value.trim()) {
      setError("Paste the address of a recipe page to get started.");
      inputRef.current?.focus();
      return;
    }

    if (!openImporter(value)) {
      setError("That doesn't look like a link. Try the full address, like https://…");
      inputRef.current?.focus();
    }
  };

  const handlePaste = async () => {
    setError(null);
    setReading(true);

    try {
      const text = await navigator.clipboard.readText();
      setValue(text.trim());

      if (!openImporter(text)) {
        setError(
          text.trim()
            ? "There's no link on your clipboard. Copy a recipe's address and try again."
            : "Your clipboard is empty. Copy a recipe's address first."
        );
      }
    } catch {
      setError("LinkDish couldn't read your clipboard. Paste the link into the field instead.");
      inputRef.current?.focus();
    } finally {
      setReading(false);
    }
  };

  const showPasteButton = clipboardAvailable && !value.trim();

  return (
    <form className="paste-link" noValidate onSubmit={handleSubmit}>
      <label className="sr-only" htmlFor={inputId}>
        {label}
      </label>
      <div className={`paste-link-field${error ? " has-error" : ""}`}>
        <Icon name="link" size={19} className="paste-link-icon" />
        <input
          aria-describedby={error ? errorId : undefined}
          aria-invalid={Boolean(error)}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          className="paste-link-input"
          enterKeyHint="go"
          id={inputId}
          inputMode="url"
          onChange={(event) => {
            setValue(event.target.value);
            setError(null);
          }}
          placeholder="Paste a recipe link"
          ref={inputRef}
          spellCheck={false}
          type="text"
          value={value}
        />
        {showPasteButton ? (
          <Button
            className="paste-link-button"
            icon="clipboard-paste"
            loading={reading}
            onClick={() => {
              void handlePaste();
            }}
            pill
            size="sm"
            variant="tonal"
          >
            Paste
          </Button>
        ) : (
          <Button
            className="paste-link-button"
            pill
            size="sm"
            trailingIcon="arrow-right"
            type="submit"
            variant="primary"
          >
            Import
          </Button>
        )}
      </div>
      {error ? (
        <p className="paste-link-error" id={errorId} role="alert">
          <Icon name="alert-circle" size={15} />
          {error}
        </p>
      ) : null}
    </form>
  );
};
