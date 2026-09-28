import React from "react";

import { Button, ButtonLink } from "../../components/Button";
import { Icon } from "../../components/Icon";
import { RecipeCard } from "../../components/RecipeCard";

import { getImportHost } from "./import-input";
import { describeNeedsRetry, IMPORT_ACTION_ICONS, IMPORT_ACTION_LABELS } from "./import-outcome";

import type { ImportActionId, ImportProblem } from "./import-outcome";
import type { ImportQueueItem } from "../../data/import-queue-store";
import type { WebSavedRecipe } from "../library/saved-recipe-types";
import type { ExtractRecipeNeedsRetry } from "@linkdish/api-contracts";

/* ------------------------------------------------------------------------------------------------
 * A problem (failure, error or allowance)
 * ---------------------------------------------------------------------------------------------- */

interface ImportProblemCardProps {
  problem: ImportProblem;
  onAction: (action: ImportActionId) => void;
  onStartOver: () => void;
}

export const ImportProblemCard: React.FC<ImportProblemCardProps> = ({
  problem,
  onAction,
  onStartOver
}) => {
  const [primary, ...secondary] = problem.actions;
  const tone = problem.isPlanLimit ? "is-limit" : problem.kind === "capacity" ? "is-calm" : "";

  return (
    <section
      aria-labelledby="import-problem-title"
      className={`import-outcome ${tone}`.trim()}
      role="alert"
    >
      <span aria-hidden="true" className="import-outcome-icon">
        <Icon name={problem.icon} size={24} />
      </span>
      <h2 className="import-outcome-title" id="import-problem-title">
        {problem.title}
      </h2>
      <p className="import-outcome-message">{problem.message}</p>
      {problem.detail ? <p className="import-outcome-detail num">{problem.detail}</p> : null}

      <div className="import-outcome-actions">
        {primary === "see_plans" ? (
          <ButtonLink icon="sparkles" size="lg" to="/pricing" variant="primary">
            {IMPORT_ACTION_LABELS.see_plans}
          </ButtonLink>
        ) : primary ? (
          <Button
            icon={IMPORT_ACTION_ICONS[primary]}
            onClick={() => onAction(primary)}
            size="lg"
            variant="primary"
          >
            {IMPORT_ACTION_LABELS[primary]}
          </Button>
        ) : null}
        {secondary.map((action) => (
          <Button
            icon={IMPORT_ACTION_ICONS[action]}
            key={action}
            onClick={() => onAction(action)}
            size="lg"
            variant="secondary"
          >
            {IMPORT_ACTION_LABELS[action]}
          </Button>
        ))}
        <Button onClick={onStartOver} size="lg" variant="ghost">
          {problem.isPlanLimit ? "Maybe later" : "Start over"}
        </Button>
      </div>
    </section>
  );
};

/* ------------------------------------------------------------------------------------------------
 * needs_retry: offer AI help
 * ---------------------------------------------------------------------------------------------- */

interface NeedsRetryCardProps {
  url: string;
  response: ExtractRecipeNeedsRetry;
  /** Metered plans: say that AI help only counts when it works. */
  metered: boolean;
  onRetryWithAi: () => void;
  onPasteText: () => void;
  onAnotherLink: () => void;
}

export const NeedsRetryCard: React.FC<NeedsRetryCardProps> = ({
  url,
  response,
  metered,
  onRetryWithAi,
  onPasteText,
  onAnotherLink
}) => {
  const copy = describeNeedsRetry(response);
  const allowAi = response.recovery?.allowFallback ?? true;
  const host = getImportHost(url);

  return (
    <section aria-labelledby="needs-retry-title" className="import-outcome is-ai">
      <span aria-hidden="true" className="import-outcome-icon">
        <Icon name="wand" size={24} />
      </span>
      {host ? (
        <p className="import-outcome-eyebrow">
          <Icon name="globe" size={14} /> {host}
        </p>
      ) : null}
      <h2 className="import-outcome-title" id="needs-retry-title">
        {copy.title}
      </h2>
      <p className="import-outcome-message">{copy.message}</p>
      {allowAi && metered ? (
        <p className="import-outcome-detail">AI help uses one import, and only if it works.</p>
      ) : null}
      <div className="import-outcome-actions">
        {allowAi ? (
          <Button icon="wand" onClick={onRetryWithAi} size="lg" variant="primary">
            Try with AI help
          </Button>
        ) : null}
        <Button icon="file-text" onClick={onPasteText} size="lg" variant="secondary">
          Paste the recipe text
        </Button>
        <Button onClick={onAnotherLink} size="lg" variant="ghost">
          Try another link
        </Button>
      </div>
    </section>
  );
};

/* ------------------------------------------------------------------------------------------------
 * Already saved (checked before any import is spent)
 * ---------------------------------------------------------------------------------------------- */

const savedOn = (iso: string): string | null => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? null
    : date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
};

interface DuplicateCardProps {
  existing: WebSavedRecipe;
  onOpen: () => void;
  onImportAgain: () => void;
  onAnotherLink: () => void;
}

export const DuplicateCard: React.FC<DuplicateCardProps> = ({
  existing,
  onOpen,
  onImportAgain,
  onAnotherLink
}) => {
  const date = savedOn(existing.createdAt);

  return (
    <section aria-labelledby="duplicate-title" className="import-outcome is-duplicate">
      <span aria-hidden="true" className="import-outcome-icon">
        <Icon name="bookmark-check" size={24} />
      </span>
      <h2 className="import-outcome-title" id="duplicate-title">
        Already in your cookbook
      </h2>
      <p className="import-outcome-message">
        {date ? `You saved this recipe on ${date}.` : "You've saved this recipe before."} Open it
        now, or import it again to get a fresh copy. Nothing is used up until you do.
      </p>
      <div className="import-outcome-recipe">
        <RecipeCard
          image={existing.recipe.image}
          meta={existing.sourceHost || getImportHost(existing.sourceUrl) || undefined}
          onNavigate={onOpen}
          title={existing.recipe.title}
          to={`/recipes/${existing.id}`}
          variant="list"
        />
      </div>
      <div className="import-outcome-actions">
        <Button icon="book-open" onClick={onOpen} size="lg" variant="primary">
          Open recipe
        </Button>
        <Button icon="refresh" onClick={onImportAgain} size="lg" variant="secondary">
          Import again
        </Button>
        <Button onClick={onAnotherLink} size="lg" variant="ghost">
          Try another link
        </Button>
      </div>
    </section>
  );
};

/* ------------------------------------------------------------------------------------------------
 * Offline: queued for later
 * ---------------------------------------------------------------------------------------------- */

export const QueuedCard: React.FC<{ item: ImportQueueItem; onDone: () => void }> = ({
  item,
  onDone
}) => (
  <section aria-labelledby="queued-title" className="import-outcome is-calm" role="status">
    <span aria-hidden="true" className="import-outcome-icon">
      <Icon name="cloud-off" size={24} />
    </span>
    <h2 className="import-outcome-title" id="queued-title">
      Saved for later
    </h2>
    <p className="import-outcome-message">
      You’re offline, so we tucked{" "}
      {item.url ? <strong>{getImportHost(item.url)}</strong> : "your text"} into your import queue.
      It’ll be imported and saved as soon as you’re back online.
    </p>
    <div className="import-outcome-actions">
      <Button icon="check" onClick={onDone} size="lg" variant="primary">
        Got it
      </Button>
    </div>
  </section>
);
