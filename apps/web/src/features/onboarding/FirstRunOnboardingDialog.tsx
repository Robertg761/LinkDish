import React, { useState } from "react";

import { Button } from "../../components/Button";

import "./FirstRunOnboardingSheet.css";

/**
 * The first-run onboarding sheet's UI. Loaded on demand by FirstRunOnboardingSheet only for
 * visitors who have not seen it yet, so returning users never download it.
 */

const frames = [
  {
    copy: ["Paste a link, share into LinkDish, or scan a page.", "The clutter falls away."],
    title: "Save recipes from anywhere",
    variant: "bookmark"
  },
  {
    copy: ["Steps stay large.", "Ingredients stay close.", "Your screen stays awake."],
    title: "Cook without losing your place",
    variant: "cook"
  },
  {
    copy: ["Family turns good recipes into a shared cookbook.", "Everyone finds dinner faster."],
    title: "Share the kitchen",
    variant: "family"
  }
] as const;

const AccentIllustration: React.FC<{ variant: (typeof frames)[number]["variant"] }> = ({
  variant
}) => {
  if (variant === "cook") {
    return (
      <svg aria-hidden="true" className="first-run-art" viewBox="0 0 180 120">
        <rect className="first-run-art-panel" height="62" rx="14" width="118" x="31" y="18" />
        <rect className="first-run-art-line-fill" height="9" rx="4.5" width="70" x="50" y="39" />
        <rect className="first-run-art-muted-fill" height="9" rx="4.5" width="46" x="50" y="58" />
        <rect className="first-run-art-timer" height="24" rx="12" width="74" x="53" y="84" />
        <circle className="first-run-art-butter" cx="68" cy="96" r="5" />
        <rect className="first-run-art-line-fill" height="6" rx="3" width="31" x="80" y="93" />
      </svg>
    );
  }

  if (variant === "family") {
    return (
      <svg aria-hidden="true" className="first-run-art" viewBox="0 0 180 120">
        <rect className="first-run-art-family-back" height="58" rx="18" width="74" x="36" y="34" />
        <rect className="first-run-art-family-front" height="58" rx="18" width="74" x="70" y="26" />
        <rect className="first-run-art-chip" height="24" rx="12" width="48" x="66" y="62" />
        <path className="first-run-art-check" d="M80 74l8 8 16-18" />
      </svg>
    );
  }

  return (
    <svg aria-hidden="true" className="first-run-art" viewBox="0 0 300 150">
      <rect className="first-run-art-url" height="30" rx="15" width="96" x="22" y="60" />
      <circle className="first-run-art-butter" cx="42" cy="75" r="4.5" />
      <rect className="first-run-art-muted-fill" height="6" rx="3" width="44" x="56" y="72" />
      <path className="first-run-art-arrow" d="M136 75h30l-11-9M166 75l-11 9" />
      <rect className="first-run-art-page" height="48" rx="12" width="44" x="184" y="51" />
      <rect className="first-run-art-page" height="48" rx="12" width="44" x="236" y="51" />
      <rect className="first-run-art-spine" height="52" rx="4" width="8" x="228" y="49" />
    </svg>
  );
};

export interface FirstRunOnboardingDialogProps {
  /** Called when the visitor skips or finishes the sheet. */
  onFinish: () => void;
}

export const FirstRunOnboardingDialog: React.FC<FirstRunOnboardingDialogProps> = ({ onFinish }) => {
  const [frameIndex, setFrameIndex] = useState(0);
  const frame = frames[frameIndex] ?? frames[0];
  const finalFrame = frameIndex === frames.length - 1;

  return (
    <div className="first-run-backdrop" role="presentation">
      <section
        aria-labelledby="first-run-title"
        aria-modal="true"
        className="first-run-sheet"
        role="dialog"
      >
        <AccentIllustration variant={frame.variant} />
        <div className="first-run-copy">
          <div className="first-run-progress" aria-hidden="true">
            {frames.map((item, index) => (
              <span
                key={item.title}
                className={`first-run-progress-dot${index === frameIndex ? " is-active" : ""}`}
              />
            ))}
          </div>
          <h2 id="first-run-title">{frame.title}</h2>
          {frame.copy.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
        <div className={`first-run-actions${finalFrame ? " is-final" : ""}`}>
          {!finalFrame ? (
            <Button variant="ghost" onClick={onFinish}>
              Skip
            </Button>
          ) : null}
          <Button
            onClick={() => {
              if (finalFrame) {
                onFinish();
                return;
              }

              setFrameIndex((current) => current + 1);
            }}
          >
            {finalFrame ? "Start cooking" : "Next"}
          </Button>
        </div>
      </section>
    </div>
  );
};
