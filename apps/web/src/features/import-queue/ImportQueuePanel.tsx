import React, { useMemo } from "react";
import { Link, useNavigate } from "react-router-dom";

import { Button } from "../../components/Button";
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
import { useUpgradeSheet } from "../upgrade/UpgradeSheet";

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
  const { requestUpgradeSheet } = useUpgradeSheet();
  const navigate = useNavigate();
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

  /** The row may be out of date: a link another tab has started importing stays. */
  const remove = (item: ImportQueueItem) =>
    act(
      removeImportQueueItem(item.id).then((removed) => {
        if (!removed) {
          showToast({ message: "That one’s importing already." });
        }
      }),
      "That couldn’t be removed."
    );

  /** Only ever opened by a tap: a full cookbook pauses the queue quietly. */
  const offerUpgrade = (trigger: "save_limit" | "import_limit") => {
    if (!requestUpgradeSheet(trigger)) {
      void navigate("/pricing?upgrade=plus");
    }
  };
  const waitingNote = `${waiting.length} ${waiting.length === 1 ? "link" : "links"} waiting`;

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
            <strong>Cookbook full · {waitingNote}.</strong> They’ll wait here until there’s room.
          </p>
          <Button onClick={() => offerUpgrade("save_limit")} size="sm" variant="primary">
            Get Plus
          </Button>
        </div>
      ) : runner.paused === "import_limit" ? (
        <div className="import-queue-note is-limit" role="status">
          <Icon name="sparkles" size={18} />
          <p>
            <strong>Imports used up · {waitingNote}.</strong> They’ll wait here for you.
          </p>
          <Button onClick={() => offerUpgrade("import_limit")} size="sm" variant="primary">
            Get Plus
          </Button>
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

          // One row anatomy: a title (the saved recipe, or the site in muted text while it's
          // pending), trailing actions, and a status line that runs the full width underneath.
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
              <p className={`import-queue-item-title${savedTitle ? "" : " is-source"}`}>
                {item.status === "done" && item.recipeId ? (
                  <Link className="import-queue-item-link" to={`/recipes/${item.recipeId}`}>
                    {savedTitle ?? label}
                  </Link>
                ) : (
                  label
                )}
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
              <div className="import-queue-item-actions">
                {item.status === "failed" && item.url && onOpenItem ? (
                  <button
                    className="import-queue-open"
                    onClick={() => onOpenItem(item)}
                    type="button"
                  >
                    Open
                  </button>
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
                    onClick={() => remove(item)}
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
