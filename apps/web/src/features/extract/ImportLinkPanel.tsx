import React, { useEffect, useId, useRef, useState } from "react";

import { Button } from "../../components/Button";
import { Icon } from "../../components/Icon";
import { IconButton } from "../../components/IconButton";

import {
  getImportHost,
  MIN_IMPORT_TEXT_CHARS,
  parseLinkList,
  parseRecipeLinkInput
} from "./import-input";
import { canReadClipboard, useClipboardLink } from "./use-clipboard-link";

interface ImportLinkPanelProps {
  initialValue?: string | undefined;
  /** Focus the field on mount (desktop; phones would pop the keyboard over the page). */
  autoFocus?: boolean | undefined;
  /** Changing this number moves focus to the field (e.g. after "Try another link"). */
  focusRequest?: number | undefined;
  disabled?: boolean | undefined;
  onImport: (url: string) => void;
  /** Several links at once: they go to the import queue. */
  onImportMany: (urls: string[]) => void;
  /** Recipe text pasted where a link was expected. */
  onPasteText?: ((text: string) => void) | undefined;
}

const ERRORS = {
  clipboard_blocked:
    "LinkDish couldn't read your clipboard. Paste the link into the field instead.",
  clipboard_empty: "Your clipboard is empty. Copy a recipe's address first.",
  clipboard_no_link: "There's no link on your clipboard. Copy a recipe's address and try again.",
  empty: "Paste the address of a recipe page to get started.",
  not_a_link: "That doesn't look like a link. Try the full address, like https://…",
  unsupported_scheme: "Only web links (http or https) can be imported."
} as const;

type ErrorKey = keyof typeof ERRORS;

const shortLink = (url: string): string => {
  const host = getImportHost(url) ?? url;

  try {
    const path = new URL(url).pathname.replace(/\/$/u, "");
    return path && path !== "/"
      ? `${host}${path.length > 22 ? `${path.slice(0, 21)}…` : path}`
      : host;
  } catch {
    return host;
  }
};

/**
 * The link field: a big, forgiving input (scheme-less links, share text and trailing punctuation
 * all work), a Paste button that imports straight from the clipboard, a "use the link you
 * copied" chip when clipboard access is already allowed, and batch import for several links.
 */
export const ImportLinkPanel: React.FC<ImportLinkPanelProps> = ({
  initialValue = "",
  autoFocus = false,
  focusRequest,
  disabled = false,
  onImport,
  onImportMany,
  onPasteText
}) => {
  const inputId = useId();
  const errorId = useId();
  const hintId = useId();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState(initialValue);
  const [error, setError] = useState<ErrorKey | null>(null);
  const [reading, setReading] = useState(false);
  const [nudge, setNudge] = useState(false);
  const clipboard = useClipboardLink(value);
  const links = parseLinkList(value);
  const isBatch = links.length > 1;
  const multiline = value.includes("\n");

  useEffect(() => {
    if (autoFocus) {
      inputRef.current?.focus({ preventScroll: true });
    }
  }, [autoFocus]);

  useEffect(() => {
    if (focusRequest) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [focusRequest]);

  // The field grows with a pasted list of links and shrinks back for a single one.
  useEffect(() => {
    const element = inputRef.current;

    if (!element) {
      return;
    }

    element.style.height = "";

    if (multiline) {
      element.style.height = `${Math.min(element.scrollHeight, 220)}px`;
    }
  }, [multiline, value]);

  const fail = (key: ErrorKey) => {
    setError(key);
    setNudge(false);
    requestAnimationFrame(() => setNudge(true));
    inputRef.current?.focus();
  };

  const submitValue = (text: string) => {
    const found = parseLinkList(text);

    if (found.length > 1) {
      onImportMany(found);
      setValue("");
      return;
    }

    const parsed = parseRecipeLinkInput(text);

    if (parsed.ok) {
      setError(null);
      onImport(parsed.url);
      return;
    }

    fail(parsed.reason);
  };

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();

    if (!disabled) {
      submitValue(value);
    }
  };

  const handlePaste = async () => {
    setError(null);
    setReading(true);
    const text = await clipboard.read();
    setReading(false);

    if (text == null) {
      fail("clipboard_blocked");
      return;
    }

    const trimmed = text.trim();

    if (!trimmed) {
      fail("clipboard_empty");
      return;
    }

    const found = parseLinkList(trimmed);

    if (found.length === 0) {
      if (onPasteText && trimmed.length >= MIN_IMPORT_TEXT_CHARS) {
        onPasteText(trimmed);
        return;
      }

      setValue(trimmed);
      fail("clipboard_no_link");
      return;
    }

    setValue(found.length > 1 ? found.join("\n") : (found[0] ?? trimmed));

    if (found.length === 1 && found[0]) {
      onImport(found[0]);
    }
  };

  const showPaste = canReadClipboard() && !value.trim();

  return (
    <form className="import-link" noValidate onSubmit={handleSubmit}>
      <label className="sr-only" htmlFor={inputId}>
        Recipe link
      </label>
      <div
        className={[
          "import-link-box",
          error ? "has-error" : "",
          nudge ? "is-nudging" : "",
          multiline ? "is-multiline" : ""
        ]
          .filter(Boolean)
          .join(" ")}
        onAnimationEnd={() => setNudge(false)}
      >
        <Icon className="import-link-icon" name="link" size={20} />
        <textarea
          aria-describedby={error ? errorId : hintId}
          aria-invalid={Boolean(error)}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          className="import-link-input"
          disabled={disabled}
          enterKeyHint="go"
          id={inputId}
          inputMode="url"
          onChange={(event) => {
            setValue(event.target.value);
            setError(null);
          }}
          onFocus={clipboard.check}
          onKeyDown={(event) => {
            // Enter imports; Shift+Enter adds another line for a list of links.
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              handleSubmit(event);
            }
          }}
          placeholder="Paste a recipe link"
          ref={inputRef}
          rows={1}
          spellCheck={false}
          value={value}
        />
        {showPaste ? (
          <Button
            className="import-link-paste"
            disabled={disabled}
            icon="clipboard-paste"
            loading={reading}
            onClick={() => void handlePaste()}
            pill
            size="sm"
            variant="tonal"
          >
            Paste
          </Button>
        ) : value ? (
          <IconButton
            aria-label="Clear link"
            className="import-link-clear"
            icon="x"
            onClick={() => {
              setValue("");
              setError(null);
              inputRef.current?.focus();
            }}
            size="sm"
          />
        ) : null}
      </div>

      {error ? (
        <p className="import-link-error" id={errorId} role="alert">
          <Icon name="alert-circle" size={16} />
          {ERRORS[error]}
        </p>
      ) : clipboard.suggestion ? (
        <div className="import-link-suggestion">
          <button
            className="import-link-suggestion-chip"
            onClick={() => {
              const link = clipboard.suggestion;

              if (link) {
                setValue(link);
                onImport(link);
              }
            }}
            type="button"
          >
            <Icon name="clipboard-paste" size={16} />
            <span className="import-link-suggestion-label">
              Use copied link <strong>{shortLink(clipboard.suggestion)}</strong>
            </span>
          </button>
          <IconButton
            aria-label="Dismiss copied link"
            icon="x"
            onClick={clipboard.dismiss}
            size="sm"
          />
        </div>
      ) : null}

      <Button
        className="import-link-submit"
        disabled={disabled}
        size="lg"
        trailingIcon="arrow-right"
        type="submit"
        variant="accent"
      >
        {isBatch ? `Import ${links.length} recipes` : "Get the recipe"}
      </Button>

      {error ? null : isBatch ? (
        <p className="import-link-hint is-batch" id={hintId}>
          <Icon name="list-checks" size={16} />
          <span>
            {links.length} links from{" "}
            {[...new Set(links.map((link) => getImportHost(link) ?? link))].join(", ")}. We’ll
            import them one by one and save each to your cookbook.
          </span>
        </p>
      ) : (
        <p className="import-link-hint" id={hintId}>
          Got a few? Paste them one per line and we’ll import them all.
        </p>
      )}
    </form>
  );
};
