import React from "react";

/*
 * Small on-brand spot illustrations for empty states. They are drawn with theme
 * tokens (via the .illo-* classes in EmptyState.css) so they follow dark mode.
 */

export type IllustrationName = "cookbook" | "basket" | "calendar" | "search" | "offline" | "pot";

const Frame: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <svg
    aria-hidden="true"
    className="illo"
    fill="none"
    focusable="false"
    height="120"
    viewBox="0 0 160 120"
    width="160"
    xmlns="http://www.w3.org/2000/svg"
  >
    <ellipse className="illo-blob" cx="82" cy="62" rx="62" ry="50" />
    <circle className="illo-dot-tomato" cx="132" cy="24" r="7" />
    <circle className="illo-dot-butter" cx="24" cy="92" r="5" />
    {children}
  </svg>
);

const Cookbook = () => (
  <Frame>
    <path className="illo-paper" d="M42 34c12-5 25-5 38 2v56c-13-7-26-7-38-2z" />
    <path className="illo-paper" d="M118 34c-12-5-25-5-38 2v56c13-7 26-7 38-2z" />
    <path className="illo-line" d="M80 36v56" />
    <path
      className="illo-line-soft"
      d="M50 48c8-2 15-2 22 1M50 58c8-2 15-2 22 1M50 68c6-1 11-1 16 0"
    />
    <path className="illo-line-soft" d="M88 49c7-3 14-3 22-1M88 59c7-3 14-3 22-1" />
    <path className="illo-accent" d="M100 66l4 8 8-12" />
  </Frame>
);

const Pot = () => (
  <Frame>
    <path className="illo-paper" d="M44 60h72v14c0 14-11 24-24 24H68c-13 0-24-10-24-24z" />
    <path className="illo-line" d="M36 60h88M50 60v-4h60v4" />
    <path className="illo-line" d="M72 50c0-4 4-6 8-6s8 2 8 6" />
    <path className="illo-steam" d="M66 38c-4-5 4-9 0-14M80 36c-4-5 4-9 0-14M94 38c-4-5 4-9 0-14" />
  </Frame>
);

const Basket = () => (
  <Frame>
    <path className="illo-line" d="M58 54l14-22M102 54L88 32" />
    <path className="illo-paper" d="M40 54h80l-9 38c-1 4-4 6-8 6H57c-4 0-7-2-8-6z" />
    <path className="illo-line-soft" d="M66 64l3 24M80 64v24M94 64l-3 24" />
    <circle className="illo-fill-tomato" cx="106" cy="48" r="9" />
    <path className="illo-leaf" d="M106 39c2-5 6-6 9-5-1 4-4 6-9 5z" />
  </Frame>
);

const Calendar = () => (
  <Frame>
    <rect className="illo-paper" height="62" rx="10" width="84" x="38" y="34" />
    <path className="illo-band" d="M38 44c0-5.5 4.5-10 10-10h64c5.5 0 10 4.5 10 10v6H38z" />
    <path className="illo-line" d="M58 28v12M102 28v12" />
    <rect className="illo-cell" height="12" rx="3" width="14" x="50" y="60" />
    <rect className="illo-cell" height="12" rx="3" width="14" x="73" y="60" />
    <rect className="illo-cell-accent" height="12" rx="3" width="14" x="96" y="60" />
    <rect className="illo-cell" height="12" rx="3" width="14" x="50" y="78" />
    <rect className="illo-cell" height="12" rx="3" width="14" x="73" y="78" />
  </Frame>
);

const Search = () => (
  <Frame>
    <circle className="illo-paper" cx="74" cy="56" r="26" />
    <circle className="illo-line" cx="74" cy="56" r="26" />
    <path className="illo-handle" d="M93 75l18 18" />
    <path className="illo-line-soft" d="M64 50c2-5 7-8 12-8" />
    <path className="illo-accent" d="M66 62l16-12M66 50l16 12" />
  </Frame>
);

const Offline = () => (
  <Frame>
    <path
      className="illo-paper"
      d="M50 84h62c11 0 18-8 18-17s-7-17-17-17c-2-12-12-20-25-20-11 0-20 6-24 16-10 0-18 8-18 19 0 11 8 19 18 19z"
    />
    <path
      className="illo-line"
      d="M50 84h62c11 0 18-8 18-17s-7-17-17-17c-2-12-12-20-25-20-11 0-20 6-24 16-10 0-18 8-18 19 0 11 8 19 18 19z"
    />
    <path className="illo-accent" d="M62 46l40 40" />
  </Frame>
);

const ILLUSTRATIONS: Record<IllustrationName, React.FC> = {
  basket: Basket,
  calendar: Calendar,
  cookbook: Cookbook,
  offline: Offline,
  pot: Pot,
  search: Search
};

export const Illustration: React.FC<{ name: IllustrationName }> = ({ name }) => {
  const Component = ILLUSTRATIONS[name];

  return <Component />;
};
