import React from "react";

import type { ShoppingCategoryId } from "@linkdish/recipe-domain";

/*
 * Aisle glyphs vendored from Lucide (https://lucide.dev), ISC License — see
 * apps/web/src/components/icons/LICENSE. Source: lucide-static@1.48.0 icon-nodes.json
 * (carrot, drumstick, milk, croissant, wheat, cookie, leaf, can, droplet, snowflake,
 * cup-soda, shopping-basket). Kept here so the shared icon set stays small.
 */

const AISLE_PATHS: Record<ShoppingCategoryId, readonly string[]> = {
  produce: [
    "M15 16a1 1 0 0 0-7-7q-4 4-5.987 12.385a.5.5 0 0 0 .602.602Q11 20 15 16l-3-3",
    "M15 9q4 4 7 0-3-4-7 0 4-4 0-7-4 3 0 7",
    "m8 15-2.58-2.58"
  ],
  "meat-seafood": [
    "M15.4 15.63a7.875 6 135 1 1 6.23-6.23 4.5 3.43 135 0 0-6.23 6.23",
    "m8.29 12.71-2.6 2.6a2.5 2.5 0 1 0-1.65 4.65A2.5 2.5 0 1 0 8.7 18.3l2.59-2.59"
  ],
  "dairy-eggs": [
    "M8 2h8",
    "M9 2v2.789a4 4 0 0 1-.672 2.219l-.656.984A4 4 0 0 0 7 10.212V20a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2v-9.789a4 4 0 0 0-.672-2.219l-.656-.984A4 4 0 0 1 15 4.788V2",
    "M7 15a6.472 6.472 0 0 1 5 0 6.47 6.47 0 0 0 5 0"
  ],
  bakery: [
    "M10.2 18H4.774a1.5 1.5 0 0 1-1.352-.97 11 11 0 0 1 .132-6.487",
    "M18 10.2V4.774a1.5 1.5 0 0 0-.97-1.352 11 11 0 0 0-6.486.132",
    "M18 5a4 3 0 0 1 4 3 2 2 0 0 1-2 2 10 10 0 0 0-5.139 1.42",
    "M5 18a3 4 0 0 0 3 4 2 2 0 0 0 2-2 10 10 0 0 1 1.42-5.14",
    "M8.709 2.554a10 10 0 0 0-6.155 6.155 1.5 1.5 0 0 0 .676 1.626l9.807 5.42a2 2 0 0 0 2.718-2.718l-5.42-9.807a1.5 1.5 0 0 0-1.626-.676"
  ],
  pantry: [
    "M2 22 16 8",
    "M3.47 12.53 5 11l1.53 1.53a3.5 3.5 0 0 1 0 4.94L5 19l-1.53-1.53a3.5 3.5 0 0 1 0-4.94Z",
    "M7.47 8.53 9 7l1.53 1.53a3.5 3.5 0 0 1 0 4.94L9 15l-1.53-1.53a3.5 3.5 0 0 1 0-4.94Z",
    "M11.47 4.53 13 3l1.53 1.53a3.5 3.5 0 0 1 0 4.94L13 11l-1.53-1.53a3.5 3.5 0 0 1 0-4.94Z",
    "M20 2h2v2a4 4 0 0 1-4 4h-2V6a4 4 0 0 1 4-4Z",
    "M11.47 17.47 13 19l-1.53 1.53a3.5 3.5 0 0 1-4.94 0L5 19l1.53-1.53a3.5 3.5 0 0 1 4.94 0Z",
    "M15.47 13.47 17 15l-1.53 1.53a3.5 3.5 0 0 1-4.94 0L9 15l1.53-1.53a3.5 3.5 0 0 1 4.94 0Z",
    "M19.47 9.47 21 11l-1.53 1.53a3.5 3.5 0 0 1-4.94 0L13 11l1.53-1.53a3.5 3.5 0 0 1 4.94 0Z"
  ],
  baking: [
    "M11 17h.01",
    "M11.496 2c.324-.016.558.292.529.615a4 4 0 004.235 4.368.713.713 0 01.758.757 4 4 0 004.366 4.237c.323-.03.63.204.614.527a10 10 0 01-2.915 6.566A1 1 0 114.93 4.918 10 10 0 0111.496 2",
    "M12 12h.01",
    "M16 16h.01",
    "M16 3h.01",
    "M21 4h.01",
    "M21 8h.01",
    "M7 14h.01",
    "M9 8h.01"
  ],
  spices: [
    "M11 20a10 10 0 0010-10 25.9 25.9 0 00-1.04-7.281 1 1 0 00-1.755-.325C15.833 5.5 13 5.5 9.8 6.1A7 7 0 0011 20",
    "M2 21a5 5 0 012.911-4.544C7.613 15.212 8.351 15.24 11 13"
  ],
  canned: [
    "M21 10.5a9 2.5 0 01-18 0v8a9 2.5 0 0018 0z",
    "M21 10.5A9 2.5 25.32 004.59 3.47 9 2.5 25.32 0021 10.5",
    "M3 10.5a9 2.5 0 016.527-2.405",
    "M9 16.858a31 31 0 006 0"
  ],
  condiments: [
    "M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C6 11.1 5 13 5 15a7 7 0 0 0 7 7z"
  ],
  frozen: [
    "m10 20-1.25-2.5L6 18",
    "M10 4 8.75 6.5 6 6",
    "m14 20 1.25-2.5L18 18",
    "m14 4 1.25 2.5L18 6",
    "m17 21-3-6h-4",
    "m17 3-3 6 1.5 3",
    "M2 12h6.5L10 9",
    "m20 10-1.5 2 1.5 2",
    "M22 12h-6.5L14 15",
    "m4 10 1.5 2L4 14",
    "m7 21 3-6-1.5-3",
    "m7 3 3 6h4"
  ],
  beverages: [
    "m6 8 1.75 12.28a2 2 0 0 0 2 1.72h4.54a2 2 0 0 0 2-1.72L18 8",
    "M5 8h14",
    "M7 15a6.47 6.47 0 0 1 5 0 6.47 6.47 0 0 0 5 0",
    "m12 8 1-6h2"
  ],
  other: [
    "m15 11-1 9",
    "m19 11-4-7",
    "M2 11h20",
    "m3.5 11 1.6 7.4a2 2 0 0 0 2 1.6h9.8a2 2 0 0 0 2-1.6l1.7-7.4",
    "M4.5 15.5h15",
    "m5 11 4-7",
    "m9 11 1 9"
  ]
};

interface AisleIconProps {
  category: ShoppingCategoryId;
  size?: number | undefined;
  className?: string | undefined;
}

/** Decorative aisle glyph (produce → carrot, frozen → snowflake, …). */
export const AisleIcon: React.FC<AisleIconProps> = ({ category, size = 20, className = "" }) => (
  <svg
    aria-hidden="true"
    className={["icon", "aisle-icon", className].filter(Boolean).join(" ")}
    fill="none"
    focusable="false"
    height={size}
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth={1.9}
    viewBox="0 0 24 24"
    width={size}
    xmlns="http://www.w3.org/2000/svg"
  >
    {(AISLE_PATHS[category] ?? AISLE_PATHS.other).map((d) => (
      <path d={d} key={d} />
    ))}
  </svg>
);
