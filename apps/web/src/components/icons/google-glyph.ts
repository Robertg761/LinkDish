/*
 * The multicolor Google "G", used only on the "Continue with Google" button as
 * Google's sign-in branding guidelines require. Drawn on an 18×18 grid.
 */
export const GOOGLE_GLYPH_VIEWBOX = "0 0 18 18";

export const GOOGLE_GLYPH_PATHS: ReadonlyArray<{ readonly d: string; readonly fill: string }> = [
  {
    d: "M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z",
    fill: "#4285F4"
  },
  {
    d: "M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.83.86-3.04.86-2.34 0-4.33-1.58-5.04-3.71H.96v2.33A9 9 0 0 0 9 18z",
    fill: "#34A853"
  },
  {
    d: "M3.96 10.71A5.41 5.41 0 0 1 3.68 9c0-.59.1-1.17.28-1.71V4.96H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.04l3-2.33z",
    fill: "#FBBC05"
  },
  {
    d: "M9 3.58c1.32 0 2.51.45 3.44 1.35l2.58-2.58A8.65 8.65 0 0 0 9 0 9 9 0 0 0 .96 4.96l3 2.33C4.67 5.16 6.66 3.58 9 3.58z",
    fill: "#EA4335"
  }
];
