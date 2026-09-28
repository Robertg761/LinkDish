import React from "react";

import { Icon } from "../../components/Icon";

import type { IconName } from "../../components/Icon";

/*
 * Three glyphs the shared icon set doesn't carry, drawn from Lucide (https://lucide.dev, ISC
 * License, see components/icons/LICENSE): "square-play", "music-2" and "pin".
 */
const EXTRA_GLYPHS = {
  note: (
    <>
      <circle cx="8" cy="18" r="4" />
      <path d="M12 18V2l7 4" />
    </>
  ),
  pin: (
    <>
      <path d="M12 17v5" />
      <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
    </>
  ),
  video: (
    <>
      <rect height="18" rx="2" width="18" x="3" y="3" />
      <path d="M9 9.003a1 1 0 0 1 1.517-.859l4.997 2.997a1 1 0 0 1 0 1.718l-4.997 2.997A1 1 0 0 1 9 14.996z" />
    </>
  )
} as const;

type ExtraGlyph = keyof typeof EXTRA_GLYPHS;

const Glyph: React.FC<{ name: ExtraGlyph }> = ({ name }) => (
  <svg
    aria-hidden="true"
    className="icon"
    fill="none"
    height={18}
    stroke="currentColor"
    strokeLinecap="round"
    strokeLinejoin="round"
    strokeWidth={2}
    viewBox="0 0 24 24"
    width={18}
  >
    {EXTRA_GLYPHS[name]}
  </svg>
);

/* Where links can come from (text and photos have their own tabs right above). */
const SOURCES: ReadonlyArray<{ label: string; icon: IconName | ExtraGlyph }> = [
  { icon: "globe", label: "Recipe sites" },
  { icon: "video", label: "YouTube & Shorts" },
  { icon: "note", label: "TikTok" },
  { icon: "pin", label: "Pinterest" }
];

const isExtraGlyph = (name: string): name is ExtraGlyph => name in EXTRA_GLYPHS;

/** "Works with": plain words and small icons, not pills, since nothing here is tappable. */
export const SupportedSources: React.FC = () => (
  <section aria-labelledby="import-sources-title" className="import-sources">
    <h2 className="import-sources-title" id="import-sources-title">
      Works with
    </h2>
    <ul className="import-sources-list">
      {SOURCES.map((source) => (
        <li className="import-sources-item" key={source.label}>
          <span aria-hidden="true" className="import-sources-icon">
            {isExtraGlyph(source.icon) ? (
              <Glyph name={source.icon} />
            ) : (
              <Icon name={source.icon} size={18} />
            )}
          </span>
          {source.label}
        </li>
      ))}
    </ul>
  </section>
);
