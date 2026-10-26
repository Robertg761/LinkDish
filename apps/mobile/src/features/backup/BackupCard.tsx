import { validateBackup } from "@linkdish/recipe-domain";
import { AppButton, AppSurface, AppText } from "@linkdish/ui";
import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import React, { useState } from "react";
import { StyleSheet, View } from "react-native";

import { trackMobileEvent } from "../../analytics/client";
import { appSpacing } from "../../theme/tokens";
import { useMealPlan } from "../meal-plan/MealPlanContext";
import { useSavedRecipes } from "../saved-recipes/SavedRecipesContext";

import {
  backupFileName,
  buildMobileBackup,
  describeRestore,
  planBackupRestore,
  readBackupExtras
} from "./backup";

/** Backups bigger than this are refused rather than read into memory (the web's limit). */
export const MAX_BACKUP_FILE_BYTES = 300 * 1024 * 1024;
const BACKUP_MIME_TYPES = ["application/json", "text/*", "application/octet-stream"];

const createId = (kind: "collection" | "plan" | "recipe"): string =>
  `${kind === "recipe" ? "saved" : kind}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

type Status = { kind: "error" | "done"; message: string } | null;

/**
 * Backups on the Household screen, as in the web app's settings: save the whole cookbook
 * (recipes and their notes, tags and history, collections, the meal plan) as a LinkDish backup
 * file through the share sheet, or restore one made here or on the web. Restoring only adds:
 * nothing already on this device is changed or removed.
 */
export const BackupCard = () => {
  const { collections, hasLoadedSavedRecipes, restoreBackup, savedRecipes } = useSavedRecipes();
  const { entries, hasLoadedMealPlan, importEntries } = useMealPlan();
  const [busy, setBusy] = useState<"export" | "restore" | null>(null);
  const [status, setStatus] = useState<Status>(null);
  const isReady = hasLoadedSavedRecipes && hasLoadedMealPlan && busy == null;

  const exportBackup = async () => {
    setBusy("export");
    setStatus(null);

    try {
      const now = new Date();
      const { backup, recipeCount } = buildMobileBackup({
        collections,
        exportedAt: now.toISOString(),
        mealPlan: entries,
        records: savedRecipes
      });
      const file = new File(Paths.cache, backupFileName(now));
      file.create({ intermediates: true, overwrite: true });
      file.write(JSON.stringify(backup));

      if (!(await Sharing.isAvailableAsync())) {
        throw new Error("Sharing is not available.");
      }

      await Sharing.shareAsync(file.uri, {
        dialogTitle: "Save your LinkDish backup",
        mimeType: "application/json"
      });
      trackMobileEvent({
        eventName: "library_exported",
        properties: { format: "backup", include_images: false, recipe_count: recipeCount },
        routeOrScreen: "account"
      });
    } catch (error) {
      console.warn("Failed to export a backup.", error);
      setStatus({ kind: "error", message: "The backup couldn't be made. Try again." });
    } finally {
      setBusy(null);
    }
  };

  const restore = async () => {
    setStatus(null);
    const picked = await File.pickFileAsync({ mimeTypes: BACKUP_MIME_TYPES }).catch(
      (error: unknown) => {
        console.warn("Failed to open the file picker.", error);
        return null;
      }
    );

    if (!picked || picked.canceled) {
      return;
    }

    setBusy("restore");

    try {
      if ((picked.result.size ?? 0) > MAX_BACKUP_FILE_BYTES) {
        setStatus({ kind: "error", message: "That file is too large to be a LinkDish backup." });
        return;
      }

      const text = await picked.result.text();
      const validated = validateBackup(text);

      if (!validated.ok) {
        setStatus({ kind: "error", message: validated.error });
        return;
      }

      const extras = readBackupExtras(JSON.parse(text) as unknown);
      const now = new Date().toISOString();
      const plan = await restoreBackup((cookbook) =>
        planBackupRestore(validated.backup, extras, {
          ...cookbook,
          createId,
          mealPlan: entries,
          now
        })
      );
      await importEntries(plan.mealPlan);
      trackMobileEvent({
        eventName: "library_imported",
        properties: {
          over_limit: plan.counts.overLimit,
          recipe_count: plan.counts.imported + plan.counts.restoredStarters,
          skipped_duplicates: plan.counts.duplicates,
          source: "linkdish"
        },
        routeOrScreen: "account"
      });
      if (validated.warnings.length) {
        console.warn("Some backup entries were skipped.", validated.warnings);
      }
      setStatus({
        kind: "done",
        message: describeRestore(plan.counts, validated.warnings.length)
      });
    } catch (error) {
      console.warn("Failed to restore a backup.", error);
      setStatus({ kind: "error", message: "The backup couldn't be restored. Try again." });
    } finally {
      setBusy(null);
    }
  };

  return (
    <AppSurface style={styles.card}>
      <AppText style={styles.centered} variant="title">
        Backups
      </AppText>
      <AppText muted style={styles.centered}>
        Save your recipes, notes, tags, collections and meal plan as a file you keep. Restore it
        here or in LinkDish on the web; restoring only adds what isn&apos;t here yet.
      </AppText>
      {status ? (
        <AppText muted={status.kind === "done"} style={styles.centered}>
          {status.message}
        </AppText>
      ) : null}
      <View style={styles.actions}>
        <AppButton
          disabled={!isReady}
          label={busy === "export" ? "Saving" : "Back up"}
          onPress={() => void exportBackup()}
          style={styles.action}
          variant="outline"
        />
        <AppButton
          disabled={!isReady}
          label={busy === "restore" ? "Restoring" : "Restore"}
          onPress={() => void restore()}
          style={styles.action}
          variant="outline"
        />
      </View>
    </AppSurface>
  );
};

const styles = StyleSheet.create({
  action: {
    flex: 1
  },
  actions: {
    flexDirection: "row",
    gap: appSpacing.sm
  },
  card: {
    gap: appSpacing.md
  },
  centered: {
    textAlign: "center"
  }
});
