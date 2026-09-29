import React from "react";

import "./PageHeader.css";

interface PageHeaderProps {
  /** Main title, set in Fraunces. */
  title: React.ReactNode;
  /** Optional italic accent word(s) in forest green after the title, e.g. "week". */
  accent?: React.ReactNode;
  /** Small label above the title, e.g. "Meal plan". */
  eyebrow?: React.ReactNode;
  subtitle?: React.ReactNode;
  /** Buttons aligned to the title row (wrap under it on phones). */
  actions?: React.ReactNode;
  size?: "md" | "lg" | undefined;
  align?: "start" | "center" | undefined;
  /** Renders an h1 by default; pages with an existing h1 can use h2. */
  headingLevel?: 1 | 2 | undefined;
  className?: string | undefined;
  id?: string | undefined;
}

/**
 * Editorial page title: "This *week*". Big, tight Fraunces with an optional italic
 * accent word underlined in butter, like the marketing site's hero.
 */
export const PageHeader: React.FC<PageHeaderProps> = ({
  title,
  accent,
  eyebrow,
  subtitle,
  actions,
  size = "md",
  align = "start",
  headingLevel = 1,
  className = "",
  id
}) => {
  const Heading = headingLevel === 2 ? "h2" : "h1";

  return (
    <header
      className={[
        "page-header",
        `page-header-${size}`,
        align === "center" ? "page-header-center" : "",
        className
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="page-header-copy">
        {eyebrow ? <p className="page-header-eyebrow">{eyebrow}</p> : null}
        <Heading className="page-header-title" id={id}>
          {title}
          {accent ? (
            <>
              {" "}
              <em className="page-header-accent">{accent}</em>
            </>
          ) : null}
        </Heading>
        {subtitle ? <p className="page-header-subtitle">{subtitle}</p> : null}
      </div>
      {actions ? <div className="page-header-actions">{actions}</div> : null}
    </header>
  );
};
