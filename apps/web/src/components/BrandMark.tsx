import React from "react";

import "./BrandMark.css";

interface BrandMarkProps {
  size?: number | undefined;
  className?: string | undefined;
}

/** The LinkDish bowl-and-link mark, drawn inline so it themes with the app. */
export const BrandMark: React.FC<BrandMarkProps> = ({ size = 32, className = "" }) => (
  <svg
    aria-hidden="true"
    className={`brand-mark ${className}`.trim()}
    fill="none"
    focusable="false"
    height={size}
    viewBox="0 0 32 32"
    width={size}
    xmlns="http://www.w3.org/2000/svg"
  >
    <path
      className="brand-mark-leaf"
      d="M21.6 9.2c.2-3 2.4-4.9 5.6-4.9-.1 3.1-2.3 5.1-5.6 4.9zm-1.2.2c-.9-1.6-.5-3.4 1-4.3.8 1.5.4 3.3-1 4.3z"
    />
    <ellipse className="brand-mark-stroke" cx="16" cy="15.5" rx="12" ry="6.8" />
    <path className="brand-mark-stroke" d="M4 16c.8 6 5.8 9.6 12 9.6S27.2 22 28 16" />
    <path
      className="brand-mark-stroke brand-mark-link"
      d="M14.4 13.1h-1.6a2.4 2.4 0 0 0 0 4.8h1.6m3.2-4.8h1.6a2.4 2.4 0 0 1 0 4.8h-1.6m-3.8-2.4h4.4"
    />
  </svg>
);
