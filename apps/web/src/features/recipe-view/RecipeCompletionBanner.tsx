import React from "react";

import { Button } from "../../components/Button";
import { Icon } from "../../components/Icon";

import type { RecipeCompletion } from "@linkdish/recipe-domain";

import "./RecipeCompletionBanner.css";

/** The video-reader warning the banner replaces in "Worth a double-check". */
export const MISSING_AMOUNTS_WARNING_PATTERN = /^The video doesn't give amounts for:/u;

/** The warnings to list under the recipe, without the one the completion banner already says. */
export const withoutCompletionWarnings = (
  warnings: readonly string[],
  completion: RecipeCompletion | null | undefined
): string[] =>
  completion
    ? warnings.filter((warning) => !MISSING_AMOUNTS_WARNING_PATTERN.test(warning))
    : [...warnings];

interface RecipeCompletionBannerProps {
  completion: RecipeCompletion | null | undefined;
  /** Fills the gaps with AI; absent when this recipe can't be changed here. */
  onFill?: (() => void) | undefined;
  filling?: boolean | undefined;
}

/*
 * A recipe read from a video that never says how much of anything goes in is saved with its
 * ingredients bare. This says so and offers to fill in the amounts with AI; once filled, it keeps
 * saying the amounts are AI estimates.
 */
export const RecipeCompletionBanner: React.FC<RecipeCompletionBannerProps> = ({
  completion,
  onFill,
  filling = false
}) => {
  if (!completion) {
    return null;
  }

  if (completion.status === "ai_filled") {
    return (
      <section
        aria-label="Amounts estimated by AI"
        className="recipe-panel recipe-completion-banner recipe-completion-banner--filled print-hide"
      >
        <Icon name="sparkles" size={18} />
        <p>
          <strong>Amounts estimated by AI.</strong> The original video didn’t give them, so check
          them before you cook.
        </p>
      </section>
    );
  }

  return (
    <section
      aria-label="Missing amounts"
      className="recipe-panel recipe-completion-banner print-hide"
    >
      <div className="recipe-completion-banner-text">
        <h2 className="recipe-section-title">
          <Icon name="info" size={18} /> This recipe is missing amounts
        </h2>
        <p>
          The video shows how it’s made but doesn’t say how much of each ingredient to use
          {completion.ingredients.length > 0 ? ` (${completion.ingredients.join(", ")})` : ""}.
        </p>
      </div>
      {onFill ? (
        <div className="recipe-completion-banner-action">
          <Button icon="sparkles" loading={filling} onClick={onFill} variant="primary">
            {filling ? "Filling in…" : "Fill in with AI"}
          </Button>
          <span className="recipe-completion-banner-hint">
            AI suggests amounts and fuller steps. Uses one AI import.
          </span>
        </div>
      ) : null}
    </section>
  );
};
