/**
 * Clerk keeps a readable `__client_uat` cookie (optionally suffixed, e.g. `__client_uat_Xy12`)
 * holding the time of the last sign-in, or "0" when signed out. It lets auth boot skip waiting
 * for Clerk's script when nobody can be signed in. A missing cookie only means "probably signed
 * out": Clerk's own answer still wins once it loads.
 */
export function hasClerkSessionHint(cookie: string = readCookie()): boolean {
  return cookie.split(";").some((part) => {
    const separator = part.indexOf("=");

    if (separator < 0) {
      return false;
    }

    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();

    return (
      (name === "__client_uat" || name.startsWith("__client_uat_")) && value !== "" && value !== "0"
    );
  });
}

function readCookie(): string {
  try {
    return typeof document === "undefined" ? "" : document.cookie;
  } catch {
    return "";
  }
}
