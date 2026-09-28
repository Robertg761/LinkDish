import React from "react";

import { Button } from "../../../components/Button";
import { Icon } from "../../../components/Icon";
import { ProgressBar } from "../../../components/ProgressBar";

import "./LibraryQuotaMeter.css";

/** From this many saved recipes the meter turns into a friendly upgrade prompt. */
export const QUOTA_NEARLY_FULL_AT = 12;

interface LibraryQuotaMeterProps {
  count: number;
  limit: number;
  onUpgrade: () => void;
}

/**
 * Free cookbooks: "4 of 15 recipes saved" as a quiet meter, becoming an upgrade prompt when the
 * cookbook is nearly full. Starter recipes never count.
 */
export const LibraryQuotaMeter: React.FC<LibraryQuotaMeterProps> = ({
  count,
  limit,
  onUpgrade
}) => {
  const nearlyFull = count >= QUOTA_NEARLY_FULL_AT;
  const full = count >= limit;
  const remaining = Math.max(0, limit - count);
  const valueText = `${Math.min(count, limit)} of ${limit} recipes saved`;

  return (
    <section
      aria-label="Free cookbook"
      className={`library-quota${nearlyFull ? " is-nearly-full" : ""}`}
    >
      {nearlyFull ? (
        <span aria-hidden="true" className="library-quota-icon">
          <Icon name={full ? "lock" : "sparkles"} size={18} />
        </span>
      ) : null}
      <div className="library-quota-copy">
        {nearlyFull ? (
          <p className="library-quota-title">
            {full ? "Your free cookbook is full" : "Your cookbook is nearly full"}
          </p>
        ) : null}
        <p className="library-quota-text">
          <span className="num">{valueText}</span>
          {nearlyFull
            ? full
              ? ". Plus makes it unlimited."
              : `. ${remaining} left on the free plan.`
            : " on the free plan"}
        </p>
        <ProgressBar
          className="library-quota-bar"
          label="Free recipes saved"
          max={limit}
          size="sm"
          tone={nearlyFull ? "tomato" : "primary"}
          value={count}
          valueText={valueText}
        />
      </div>
      <Button
        className="library-quota-action"
        onClick={onUpgrade}
        pill
        size="sm"
        variant={nearlyFull ? "primary" : "ghost"}
      >
        {nearlyFull ? "Get Plus" : "Go unlimited"}
      </Button>
    </section>
  );
};
