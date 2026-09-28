import React from "react";

import { Button } from "../../../components/Button";
import { Icon } from "../../../components/Icon";
import { ProgressBar } from "../../../components/ProgressBar";

import type { FreeQuotaSummary } from "./free-quota";

import "./LibraryQuotaMeter.css";

interface LibraryQuotaMeterProps {
  quota: FreeQuotaSummary;
  onUpgrade: () => void;
}

const PROMPT_TITLES = {
  full: "Cookbook full",
  nearly_full: "Almost full",
  over: "Over the free limit"
} as const;

/**
 * Free cookbooks: "4 of 15 saved" as a quiet meter, becoming an upgrade prompt when the cookbook
 * is nearly full. The count is the true one (never clamped), and starter recipes never count —
 * the meter says so whenever there are any, so it always adds up with the header.
 */
export const LibraryQuotaMeter: React.FC<LibraryQuotaMeterProps> = ({ quota, onUpgrade }) => {
  const bar = (
    <ProgressBar
      className="library-quota-bar"
      label="Free recipes saved"
      max={quota.limit}
      size="sm"
      tone={quota.tone}
      value={quota.saved}
      valueText={quota.valueText}
    />
  );

  if (quota.state === "roomy") {
    return (
      <section aria-label="Free cookbook" className="library-quota">
        <div className="library-quota-copy">
          <p className="library-quota-text">
            <span className="num">{quota.valueText}</span> on the free plan
            {quota.starterNote ? (
              <span className="library-quota-note"> · {quota.starterNote}</span>
            ) : null}
          </p>
          {bar}
        </div>
        <Button className="library-quota-action" onClick={onUpgrade} pill size="sm" variant="ghost">
          Go unlimited
        </Button>
      </section>
    );
  }

  return (
    <section aria-label="Free cookbook" className={`library-quota is-prompt is-${quota.state}`}>
      <span aria-hidden="true" className="library-quota-icon">
        <Icon name={quota.state === "nearly_full" ? "sparkles" : "lock"} size={18} />
      </span>
      <p className="library-quota-title">{PROMPT_TITLES[quota.state]}</p>
      <p className="library-quota-text">
        <span className="num">{quota.valueText}</span> · {quota.statusText}.
        {quota.state === "over" ? " Everything stays; new saves need Plus." : null}
        {quota.starterNote ? (
          <span className="library-quota-note"> {quota.starterNote}</span>
        ) : null}
      </p>
      {bar}
      <Button className="library-quota-action" onClick={onUpgrade} pill size="sm">
        Get Plus
      </Button>
    </section>
  );
};
