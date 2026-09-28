import React, { useMemo } from "react";
import { Link } from "react-router-dom";

import { Button, ButtonLink } from "../../components/Button";
import { Icon } from "../../components/Icon";
import { IconButton } from "../../components/IconButton";
import { useToast } from "../../components/Toast";
import {
  clearFinishedImports,
  removeImportQueueItem,
  retryImport,
  useImportQueue,
  type ImportQueueItem
} from "../../data/import-queue-store";
import { useSavedRecipes } from "../../data/library-store";
import { getImportHost } from "../extract/import-input";

import type { ImportQueueRunnerState } from "./use-import-queue-runner";
import type { IconName } from "../../components/Icon";

import "./ImportQueuePanel.css";

interface ImportQueuePanelProps {
  /** The page's queue worker (see useImportQueueRunner), so it keeps going while hidden. */
  runner: ImportQueueRunnerState;
  /** Takes a failed link back into the interactive importer (e.g. for AI help). */
  onOpenItem?: ((item: ImportQueueItem) => void) | undefined;
}

const STATUS_ICON: Record<ImportQueueItem["status"], IconName> = {
  done: "check",
  failed: "alert-circle",
  processing: "loader",
  queued: "clock"
};

const textPreview = (text: string | undefined): string => {
  const firstLine = (text ?? "").trim().split(/\n/u)[0] ?? "";
  return firstLine.length > 48 ? `${firstLine.slice(0, 47)}…` : firstLine || "Pasted text";
};

/**
 * Links waiting to be imported (a batch paste, or shares made while offline). The page's
 * worker imports them one at a time and saves each success automatically; failures stay here
 * with Retry and Remove.
 */
export const ImportQueuePanel: React.FC<ImportQueuePanelProps> = ({ onOpenItem, runner }) => {
  const { items } = useImportQueue();
  const { recipes } = useSavedRecipes();
  const { showToast } = useToast();
  const titles = useMemo(
    () => new Map(recipes.map((recipe) => [recipe.id, recipe.recipe.title])),
    [recipes]
  );
  const waiting = items.filter((item) => item.status === "queued" || item.status === "processing");
  const finished = items.filter((item) => item.status === "done");

  if (items.length === 0) {
    return null;
  }

  const summary = runner.paused
    ? "Paused"
    : waiting.length > 0
      ? `${waiting.length} to go`
      : "All done";

  const act = (task: Promise<unknown>, failure: string) => {
    void task.catch(() => showToast({ message: failure, tone: "danger" }));
  };

  return (
    <section aria-labelledby="import-queue-title" className="import-queue">
      <header className="import-queue-head">
        <div className="import-queue-heading">
          <h2 className="import-queue-title" id="import-queue-title">
            Import queue
          </h2>
          <span className={`import-queue-summary${runner.running ? " is-running" : ""}`}>
            {summary}
          </span>
        </div>
        {finished.length > 0 ? (
          <Button
            onClick={() => act(clearFinishedImports(), "The finished imports couldn’t be cleared.")}
            size="sm"
            variant="ghost"
          >
            Clear done
          </Button>
        ) : null}
      </header>

      {runner.paused === "save_limit" ? (
        <div className="import-queue-note is-limit" role="status">
          <Icon name="bookmark-check" size={18} />
          <p>
            <strong>Your cookbook is full.</strong> The rest will wait here until there’s room.
          </p>
          <ButtonLink size="sm" to="/pricing" variant="primary">
            See plans
          </ButtonLink>
        </div>
      ) : runner.paused === "import_limit" ? (
        <div className="import-queue-note is-limit" role="status">
          <Icon name="sparkles" size={18} />
          <p>
            <strong>You’ve used your imports.</strong> These links will wait here for you.
          </p>
          <ButtonLink size="sm" to="/pricing" variant="primary">
            See plans
          </ButtonLink>
        </div>
      ) : !runner.online && waiting.length > 0 ? (
        <div className="import-queue-note" role="status">
          <Icon name="wifi-off" size={18} />
          <p>You’re offline. We’ll carry on as soon as you’re back.</p>
        </div>
      ) : null}

      <ul className="import-queue-list">
        {items.map((item) => {
          const label = item.url ? (getImportHost(item.url) ?? item.url) : textPreview(item.text);
          const savedTitle = item.recipeId ? titles.get(item.recipeId) : undefined;

          return (
            <li className={`import-queue-item is-${item.status}`} key={item.id}>
              <span aria-hidden="true" className="import-queue-item-icon">
                <Icon
                  className={item.status === "processing" ? "import-queue-spin" : undefined}
                  name={STATUS_ICON[item.status]}
                  size={16}
                  strokeWidth={item.status === "done" ? 2.8 : 2}
                />
              </span>
              <div className="import-queue-item-copy">
                <p className="import-queue-item-title">
                  {item.status === "done" && savedTitle ? savedTitle : label}
                </p>
                <p className="import-queue-item-status">
                  {item.status === "queued"
                    ? "Waiting"
                    : item.status === "processing"
                      ? "Importing…"
                      : item.status === "done"
                        ? `Saved${savedTitle ? ` · ${label}` : ""}`
                        : (item.error ?? "This import didn’t work.")}
                </p>
              </div>
              <div className="import-queue-item-actions">
                {item.status === "done" && item.recipeId ? (
                  <Link className="import-queue-open" to={`/recipes/${item.recipeId}`}>
                    Open
                  </Link>
                ) : null}
                {item.status === "failed" && item.url && onOpenItem ? (
                  <Button onClick={() => onOpenItem(item)} size="sm" variant="secondary">
                    Open
                  </Button>
                ) : null}
                {item.status === "failed" ? (
                  <IconButton
                    aria-label={`Retry ${label}`}
                    icon="refresh"
                    onClick={() => act(retryImport(item.id), "That couldn’t be retried.")}
                    size="sm"
                    variant="tonal"
                  />
                ) : null}
                {item.status !== "processing" ? (
                  <IconButton
                    aria-label={`Remove ${label}`}
                    icon="x"
                    onClick={() => act(removeImportQueueItem(item.id), "That couldn’t be removed.")}
                    size="sm"
                  />
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
};
