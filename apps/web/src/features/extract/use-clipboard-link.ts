import { useCallback, useState } from "react";

import { parseLinkList } from "./import-input";

/**
 * Clipboard help for the link field. Reading the clipboard normally shows a permission prompt,
 * so the "use the link you copied" suggestion only appears when the browser has already granted
 * clipboard access; the Paste button reads it on demand (a user gesture) everywhere else.
 */

export const canReadClipboard = (): boolean =>
  typeof navigator !== "undefined" && typeof navigator.clipboard?.readText === "function";

const clipboardAlreadyAllowed = async (): Promise<boolean> => {
  try {
    const status = await navigator.permissions.query({
      name: "clipboard-read" as PermissionName
    });
    return status.state === "granted";
  } catch {
    // Firefox and older Safari don't know this permission.
    return false;
  }
};

export interface ClipboardLinkSuggestion {
  /** A link found on the clipboard, offered as a one-tap chip. */
  suggestion: string | null;
  /** Looks for a link on the clipboard without prompting (call on focus). */
  check: () => void;
  dismiss: () => void;
  /** Reads the clipboard (prompting if needed). Null when unavailable or refused. */
  read: () => Promise<string | null>;
}

export function useClipboardLink(currentValue: string): ClipboardLinkSuggestion {
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);

  const read = useCallback(async (): Promise<string | null> => {
    if (!canReadClipboard()) {
      return null;
    }

    try {
      const text: unknown = await navigator.clipboard.readText();
      return typeof text === "string" ? text : null;
    } catch {
      return null;
    }
  }, []);

  const check = useCallback(() => {
    if (!canReadClipboard() || typeof navigator.permissions?.query !== "function") {
      return;
    }

    void (async () => {
      if (!(await clipboardAlreadyAllowed())) {
        return;
      }

      const text = await read();
      const link = text ? (parseLinkList(text)[0] ?? null) : null;
      setSuggestion(link);
    })();
  }, [read]);

  const dismiss = useCallback(() => {
    setDismissed(suggestion);
    setSuggestion(null);
  }, [suggestion]);

  const visible =
    suggestion && suggestion !== dismissed && !currentValue.includes(suggestion)
      ? suggestion
      : null;

  return { check, dismiss, read, suggestion: visible };
}
