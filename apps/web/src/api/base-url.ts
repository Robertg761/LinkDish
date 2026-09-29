/** Origin of the LinkDish API (no trailing slash). */
export const apiBaseUrl = (
  (import.meta.env.VITE_LINKDISH_API_BASE_URL as string | undefined) || "https://api.linkdish.ca"
).replace(/\/+$/, "");
