import React, { useEffect, useMemo, useState } from "react";

import { Button } from "../../components/Button";
import { Icon } from "../../components/Icon";
import { Switch } from "../../components/Switch";
import { useToast } from "../../components/Toast";
import { formatBytes } from "../data-transfer/device-storage";
import { getDataTransferErrorMessage } from "../data-transfer/errors";
import { selectExportRecipes } from "../data-transfer/export-selection";
import { describeLastBackup, readLastBackupAt } from "../data-transfer/last-backup";
import { measureSourceImages } from "../data-transfer/local-data";

import type { WebSavedRecipe } from "../library/saved-recipe-types";

interface BackupCardProps {
  recipes: readonly WebSavedRecipe[];
  recipesReady: boolean;
  collectionCount: number | null;
  mealPlanCount: number | null;
}

const loadFlows = () => import("../data-transfer/data-transfer");

const plural = (count: number, one: string, many = `${one}s`): string =>
  `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;

const listPhrase = (parts: readonly string[]): string =>
  parts.length <= 1
    ? (parts[0] ?? "")
    : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;

export const BackupCard: React.FC<BackupCardProps> = ({
  recipes,
  recipesReady,
  collectionCount,
  mealPlanCount
}) => {
  const { showToast } = useToast();
  const [includeImages, setIncludeImages] = useState(false);
  const [busy, setBusy] = useState<"backup" | "text" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastBackupAt, setLastBackupAt] = useState(readLastBackupAt);
  const [photoBytes, setPhotoBytes] = useState<number | null>(null);
  const exportable = useMemo(() => selectExportRecipes(recipes), [recipes]);
  const scannedRecipes = exportable.filter((recipe) => (recipe.sourceImageCount ?? 0) > 0).length;
  const scannedKey = exportable
    .filter((recipe) => (recipe.sourceImageCount ?? 0) > 0)
    .map((recipe) => recipe.id)
    .join("|");

  useEffect(() => {
    if (!scannedKey) {
      setPhotoBytes(null);
      return;
    }

    let cancelled = false;
    measureSourceImages(new Set(scannedKey.split("|"))).then(
      (stats) => {
        if (!cancelled) {
          setPhotoBytes(stats.bytes);
        }
      },
      () => undefined
    );

    return () => {
      cancelled = true;
    };
  }, [scannedKey]);

  const contents = listPhrase(
    [
      plural(exportable.length, "recipe"),
      collectionCount ? plural(collectionCount, "collection") : null,
      mealPlanCount ? plural(mealPlanCount, "planned meal") : null
    ].filter((part): part is string => Boolean(part))
  );

  const handleBackup = async () => {
    setBusy("backup");
    setError(null);

    try {
      const { downloadBackup } = await loadFlows();
      const summary = await downloadBackup({ includeImages: includeImages && scannedRecipes > 0 });
      setLastBackupAt(readLastBackupAt());
      showToast({
        icon: "check-circle",
        message: `Backup saved: ${summary.fileName}`,
        tone: "success"
      });
    } catch (caught) {
      setError(getDataTransferErrorMessage(caught, "export"));
    } finally {
      setBusy(null);
    }
  };

  const handleText = async () => {
    setBusy("text");
    setError(null);

    try {
      const { downloadCookbookText } = await loadFlows();
      const summary = await downloadCookbookText();
      showToast({
        icon: "file-text",
        message: `Saved ${plural(summary.recipeCount, "recipe")} as ${summary.fileName}`
      });
    } catch (caught) {
      setError(getDataTransferErrorMessage(caught, "export"));
    } finally {
      setBusy(null);
    }
  };

  const empty = recipesReady && exportable.length === 0;

  return (
    <div className="settings-card settings-data-card" data-testid="backup-card">
      <div className="settings-data-card-header">
        <span className="settings-data-card-icon" aria-hidden="true">
          <Icon name="download" size={20} />
        </span>
        <div className="settings-data-card-heading">
          <h3 className="settings-data-card-title">Back up your cookbook</h3>
          <p className="settings-data-card-text">
            {!recipesReady
              ? "Gathering your recipes…"
              : empty
                ? "Save a recipe first — then you can keep a copy of your cookbook here."
                : `One file with your ${contents} — favorites, tags, ratings, notes and cooking history included. Keep it somewhere safe, like your email or a cloud drive.`}
          </p>
        </div>
      </div>

      {scannedRecipes > 0 ? (
        <div className="settings-data-option">
          <Switch
            checked={includeImages}
            description={`Adds ${photoBytes === null ? "the original photos" : `about ${formatBytes(photoBytes)}`} for ${plural(scannedRecipes, "photo import")}.`}
            label="Include scanned photos"
            onChange={setIncludeImages}
          />
        </div>
      ) : null}

      {error ? (
        <p className="settings-data-error" role="alert">
          <Icon name="alert-circle" size={16} />
          {error}
        </p>
      ) : null}

      <div className="settings-data-actions">
        <Button
          disabled={!recipesReady || empty || busy !== null}
          icon="download"
          loading={busy === "backup"}
          onClick={() => void handleBackup()}
        >
          Download a backup
        </Button>
        <Button
          disabled={!recipesReady || empty || busy !== null}
          icon="file-text"
          loading={busy === "text"}
          onClick={() => void handleText()}
          variant="secondary"
        >
          Export as text
        </Button>
      </div>
      <p className="settings-data-footnote">
        {lastBackupAt
          ? `Last backup from this browser: ${describeLastBackup(lastBackupAt)}.`
          : "“Export as text” saves a readable Markdown file for notes apps or printing."}
      </p>
    </div>
  );
};
