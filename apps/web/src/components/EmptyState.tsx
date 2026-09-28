import React from "react";

import { Illustration } from "./illustrations";

import type { IllustrationName } from "./illustrations";

import "./EmptyState.css";

interface EmptyStateProps {
  title: React.ReactNode;
  body?: React.ReactNode;
  /** A built-in spot illustration. */
  illustration?: IllustrationName | undefined;
  /** Custom artwork instead of a built-in illustration. */
  art?: React.ReactNode;
  /** Buttons / links, typically one primary and one quiet action. */
  actions?: React.ReactNode;
  /** Tighter spacing for use inside cards and sheets. */
  compact?: boolean | undefined;
  /** 1 when the empty state is the whole page (e.g. "Recipe not found"). */
  headingLevel?: 1 | 2 | 3 | undefined;
  className?: string | undefined;
}

export const EmptyState: React.FC<EmptyStateProps> = ({
  title,
  body,
  illustration,
  art,
  actions,
  compact = false,
  headingLevel = 2,
  className = ""
}) => {
  const Heading = headingLevel === 1 ? "h1" : headingLevel === 3 ? "h3" : "h2";
  const artwork = art ?? (illustration ? <Illustration name={illustration} /> : null);

  return (
    <div
      className={["empty-state", compact ? "empty-state-compact" : "", className].join(" ").trim()}
    >
      {artwork ? <div className="empty-state-art">{artwork}</div> : null}
      <Heading className="empty-state-title">{title}</Heading>
      {body ? <div className="empty-state-body">{body}</div> : null}
      {actions ? <div className="empty-state-actions">{actions}</div> : null}
    </div>
  );
};
