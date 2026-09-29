const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Decodes base64url (padding optional) into a byte-per-char string; null when it isn't base64. */
const decodeBase64Url = (value: string): string | null => {
  let bits = 0;
  let bitCount = 0;
  let decoded = "";

  for (const char of value) {
    if (char === "=") {
      break;
    }

    const index = BASE64_ALPHABET.indexOf(char === "-" ? "+" : char === "_" ? "/" : char);

    if (index === -1) {
      return null;
    }

    bits = (bits << 6) | index;
    bitCount += 6;

    if (bitCount >= 8) {
      bitCount -= 8;
      decoded += String.fromCharCode((bits >> bitCount) & 0xff);
      bits &= (1 << bitCount) - 1;
    }
  }

  return decoded;
};

/**
 * The Clerk session a bearer token was issued for: the `sid` claim of a Clerk session JWT, or
 * null for any other token (a legacy session token, none at all). Only read, never verified: it
 * tells which session's credentials a request is about to carry, so a request made for one
 * account can refuse to go out with another's.
 */
export const getTokenSessionId = (token: string | null | undefined): string | null => {
  const parts = token?.split(".") ?? [];
  const payload = parts.length === 3 ? decodeBase64Url(parts[1] ?? "") : null;

  if (!payload) {
    return null;
  }

  try {
    const claims = JSON.parse(payload) as unknown;
    const sid =
      typeof claims === "object" && claims !== null ? (claims as { sid?: unknown }).sid : null;
    return typeof sid === "string" && sid ? sid : null;
  } catch {
    return null;
  }
};
