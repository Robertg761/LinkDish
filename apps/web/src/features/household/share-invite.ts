export type ShareOutcome = "shared" | "copied" | "cancelled" | "failed";

const isAbortError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  (error as { name?: unknown }).name === "AbortError";

/** Copies text, falling back to a hidden textarea where the async clipboard is unavailable. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Permission denied or insecure context: try the legacy path below.
  }

  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    // execCommand is deprecated but still the only fallback on some older browsers.
    const copied = document.execCommand?.("copy") ?? false;
    textarea.remove();
    return copied;
  } catch {
    return false;
  }
}

/**
 * Opens the system share sheet when the browser has one; otherwise (or if sharing fails for a
 * reason other than the person closing it) copies the link instead.
 */
export async function shareOrCopy(data: {
  title: string;
  text: string;
  url: string;
}): Promise<ShareOutcome> {
  if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
    try {
      await navigator.share(data);
      return "shared";
    } catch (error) {
      if (isAbortError(error)) {
        return "cancelled";
      }
    }
  }

  return (await copyText(data.url)) ? "copied" : "failed";
}

export const canUseSystemShare = (): boolean =>
  typeof navigator !== "undefined" && typeof navigator.share === "function";
