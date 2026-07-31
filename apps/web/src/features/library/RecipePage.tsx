import React, { useState, useEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { useParams, useNavigate } from "react-router-dom";

import { trackWebEvent } from "../../analytics/client";
import { apiClient } from "../../api/client";
import { useAuth } from "../../auth/AuthProvider";
import { Button, ButtonLink } from "../../components/Button";
import { Card } from "../../components/Card";
import { Chip } from "../../components/Chip";
import { ConfirmationDialog } from "../../components/ConfirmationDialog";
import { ErrorState } from "../../components/ErrorState";
import { Icon } from "../../components/Icon";
import { RecipeImageWithFallback } from "../../components/RecipeImageWithFallback";
import { buildRecipeImageUrl, getRecipeImageOrNull } from "../../lib/recipe-image";
import { createShareCardBlob } from "../../lib/share-card";
import {
  CookMode,
  DEFAULT_RECIPE_SCALING_STATE,
  RecipeScaleControls,
  getIngredientUnitLabels,
  getScaledIngredientText,
  hasAlternateIngredientUnits,
  hasUnscalableIngredients
} from "../recipes/CookMode";
import { buildRecipeMetaLine } from "../recipes/recipe-meta";
import { AddRecipeToShoppingSheet } from "../shopping/AddRecipeToShoppingSheet";
import { useUpgradeSheet } from "../upgrade/UpgradeSheet";

import {
  deleteSavedRecipe,
  duplicateSavedRecipe,
  getSharedRecipeOwnerLabel,
  getSavedRecipeById,
  incrementSavedRecipeTimesCooked,
  saveSharedRecipeCopy,
  sharedRecipeToWebSavedRecipe,
  syncRecipeToHousehold,
  updateSavedRecipe
} from "./saved-recipe-store";

import type { WebSavedRecipe } from "./saved-recipe-types";
import type { SharedRecipe } from "@linkdish/api-contracts";
import type { Recipe } from "@linkdish/recipe-domain";
import "./RecipePage.css";

const getShareCardFilename = (title: string): string => {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "")
    .slice(0, 48);

  return `${slug || "linkdish-recipe"}-share-card.png`;
};

const downloadBlob = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
};

const nutritionRows = [
  ["Calories", "calories"],
  ["Protein", "protein"],
  ["Carbohydrates", "carbohydrates"],
  ["Fat", "fat"],
  ["Fiber", "fiber"],
  ["Sugar", "sugar"],
  ["Sodium", "sodium"]
] as const;

const splitEditableLines = (value: string): string[] =>
  value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);

const splitEditableIngredients = (
  value: string
): Array<{ section?: string | undefined; text: string }> => {
  let currentSection: string | undefined;
  const ingredients: Array<{ section?: string | undefined; text: string }> = [];

  for (const line of splitEditableLines(value)) {
    const heading = line.match(/^#?\s*([^:#][^:]{0,80}):$/u)?.[1]?.trim();

    if (heading) {
      currentSection = heading;
      continue;
    }

    ingredients.push({
      ...(currentSection ? { section: currentSection } : {}),
      text: line
    });
  }

  return ingredients;
};

const formatEditableIngredients = (ingredients: Recipe["ingredients"]): string => {
  const lines: string[] = [];
  let currentSection: string | null | undefined;

  for (const ingredient of ingredients) {
    const section = ingredient.section?.trim();

    if (section && section !== currentSection) {
      if (lines.length > 0) {
        lines.push("");
      }

      lines.push(`${section}:`);
      currentSection = section;
    } else if (!section) {
      currentSection = null;
    }

    lines.push(ingredient.text);
  }

  return lines.join("\n");
};

export const RecipePage: React.FC = () => {
  const { id, sharedId } = useParams<{ id?: string; sharedId?: string }>();
  const navigate = useNavigate();
  const { isAuthenticated, loading: authLoading, user } = useAuth();
  const { requestUpgradeSheet } = useUpgradeSheet();
  const [recipe, setRecipe] = useState<WebSavedRecipe | null>(null);
  const [sharedRecipe, setSharedRecipe] = useState<SharedRecipe | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionMessage, setActionMessage] = useState("");
  const [actionLoading, setActionLoading] = useState<
    "delete" | "duplicate" | "sync" | "edit" | "shareCard" | null
  >(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorError, setEditorError] = useState("");
  const [draftTitle, setDraftTitle] = useState("");
  const [draftServings, setDraftServings] = useState("");
  const [draftIngredients, setDraftIngredients] = useState("");
  const [draftSteps, setDraftSteps] = useState("");
  const [draftNotes, setDraftNotes] = useState("");
  const [nutritionExpanded, setNutritionExpanded] = useState(true);
  const [recipeScaling, setRecipeScaling] = useState(DEFAULT_RECIPE_SCALING_STATE);
  const [shoppingSheetOpen, setShoppingSheetOpen] = useState(false);
  const [shoppingCanSync, setShoppingCanSync] = useState(false);
  const [deleteConfirmationVisible, setDeleteConfirmationVisible] = useState(false);
  const openedRecipeKeyRef = useRef<string | null>(null);
  const unitLabels = useMemo(
    () => getIngredientUnitLabels(recipe?.recipe.ingredients ?? []),
    [recipe?.recipe.ingredients]
  );

  const loadRecipe = async () => {
    if (!id && !sharedId) return;

    try {
      if (sharedId) {
        if (!isAuthenticated) {
          setSharedRecipe(null);
          setRecipe(null);
          return;
        }

        const response = await apiClient.getSharedRecipes();
        const storedSharedRecipe = response.recipes.find((entry) => entry.id === sharedId) ?? null;
        setSharedRecipe(storedSharedRecipe);
        setRecipe(storedSharedRecipe ? sharedRecipeToWebSavedRecipe(storedSharedRecipe) : null);
        return;
      }

      if (!id) {
        return;
      }

      const stored = await getSavedRecipeById(id);
      setSharedRecipe(null);
      setRecipe(stored ?? null);
    } catch (err) {
      console.error("Failed to load recipe:", err);
      setRecipe(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setLoading(true);

    if (sharedId && authLoading) {
      return;
    }

    void loadRecipe();
  }, [authLoading, id, isAuthenticated, sharedId]);

  const isSharedRoute = sharedId != null;
  const canEditSharedRecipe = sharedRecipe?.ownerUserId === user?.id;

  useEffect(() => {
    if (!recipe) {
      return;
    }

    const openedKey = sharedId ? `shared:${sharedId}` : `saved:${recipe.id}`;

    if (openedRecipeKeyRef.current === openedKey) {
      return;
    }

    openedRecipeKeyRef.current = openedKey;
    trackWebEvent({
      eventName: "recipe_opened",
      routeOrScreen: sharedId ? "/recipes/shared/:id" : "/recipes/:id",
      properties: {
        surface: sharedId ? "shared_link" : "recipe_detail"
      }
    });
  }, [recipe, sharedId]);

  const handleCookModeFinish = async () => {
    if (!id || isSharedRoute) {
      return;
    }

    const updatedRecipe = await incrementSavedRecipeTimesCooked(id);

    if (updatedRecipe) {
      setRecipe(updatedRecipe);
    }
  };

  const openEditor = () => {
    if (!recipe) {
      return;
    }

    setDraftTitle(recipe.recipe.title);
    setDraftServings(recipe.recipe.servings ?? "");
    setDraftIngredients(formatEditableIngredients(recipe.recipe.ingredients));
    setDraftSteps(
      [...recipe.recipe.steps]
        .sort((a, b) => a.index - b.index)
        .map((step) => step.text)
        .join("\n")
    );
    setDraftNotes(recipe.notes ?? "");
    setEditorError("");
    setEditorOpen(true);
  };

  const handleSaveEdits = async () => {
    if (!recipe) {
      return;
    }

    const title = draftTitle.trim();
    const ingredients = splitEditableIngredients(draftIngredients);
    const steps = splitEditableLines(draftSteps);

    if (!title || ingredients.length === 0 || steps.length === 0) {
      setEditorError("Title, ingredients, and method all need at least one entry.");
      return;
    }

    setActionLoading("edit");
    setEditorError("");

    try {
      const editedRecipe: Recipe = {
        ...recipe.recipe,
        ingredients,
        servings: draftServings.trim() || null,
        steps: steps.map((text, index) => ({ index: index + 1, text })),
        title
      };
      if (isSharedRoute && sharedRecipe) {
        const response = await apiClient.updateSharedRecipe(sharedRecipe.id, {
          notes: draftNotes.trim() || null,
          recipe: editedRecipe
        });
        setSharedRecipe(response.recipe);
        setRecipe(sharedRecipeToWebSavedRecipe(response.recipe));
        setEditorOpen(false);
        setActionMessage("Family recipe updated.");
        return;
      }

      const updatedRecipe = await updateSavedRecipe(recipe.id, {
        notes: draftNotes,
        recipe: editedRecipe
      });

      if (!updatedRecipe) {
        setEditorError("This saved recipe is no longer available.");
        return;
      }

      setRecipe(updatedRecipe);
      setEditorOpen(false);
      setActionMessage(
        updatedRecipe.sync?.sharedRecipeId
          ? "Recipe updated locally. Sync it when you are ready to update the household copy."
          : "Recipe updated."
      );
    } catch (err) {
      console.error("Save edits failed:", err);
      setEditorError(
        err instanceof Error ? err.message : "This recipe could not be updated. Please try again."
      );
    } finally {
      setActionLoading(null);
    }
  };

  const handleDuplicate = async () => {
    if (!recipe) {
      return;
    }

    setActionLoading("duplicate");
    setActionMessage("");

    try {
      const duplicate = sharedRecipe
        ? await saveSharedRecipeCopy(sharedRecipe)
        : await duplicateSavedRecipe(recipe.id);

      if (duplicate) {
        void navigate(`/recipes/${duplicate.id}`);
      } else {
        setActionMessage("This recipe is no longer available to duplicate.");
      }
    } catch (err) {
      console.error("Duplicate failed:", err);
      setActionMessage("This recipe could not be duplicated. Please try again.");
    } finally {
      setActionLoading(null);
    }
  };

  const handleDeleteRecipe = async () => {
    if (!recipe) {
      return;
    }

    setActionLoading("delete");
    setActionMessage("");

    try {
      if (isSharedRoute && sharedRecipe) {
        await apiClient.deleteSharedRecipe(sharedRecipe.id);
      } else {
        await deleteSavedRecipe(recipe.id);
      }
      void navigate("/");
    } catch (err) {
      console.error("Delete failed:", err);
      setActionMessage("This recipe could not be deleted. Please try again.");
      setDeleteConfirmationVisible(false);
    } finally {
      setActionLoading(null);
    }
  };

  const handleSync = async () => {
    if (!recipe || !isAuthenticated) {
      return;
    }

    setActionLoading("sync");
    setActionMessage("");
    const wasAlreadyShared = Boolean(recipe.sync?.sharedRecipeId);

    try {
      const syncedRecipe = await syncRecipeToHousehold(recipe);
      setRecipe(syncedRecipe);
      if (syncedRecipe.sync?.status === "synced" && !wasAlreadyShared) {
        trackWebEvent({
          eventName: "family_shared",
          routeOrScreen: "/recipes/:id",
          properties: {
            recipe_count: 1,
            share_scope: "household"
          }
        });
      }
      if (syncedRecipe.sync?.status === "local_only") {
        requestUpgradeSheet("family_share_no_plan");
      }
      setActionMessage(
        syncedRecipe.sync?.status === "synced"
          ? "Synced to your household."
          : (syncedRecipe.sync?.lastError ?? "This recipe could not be synced.")
      );
    } finally {
      setActionLoading(null);
    }
  };

  const openShoppingSheet = async () => {
    setShoppingCanSync(false);

    if (isAuthenticated) {
      try {
        const householdResponse = await apiClient.getHousehold();
        setShoppingCanSync(Boolean(householdResponse.household));
      } catch {
        setShoppingCanSync(false);
      }
    }

    setShoppingSheetOpen(true);
  };

  if (loading) {
    return (
      <div className="recipe-page container page-enter">
        <p className="recipe-loading">Loading recipe...</p>
      </div>
    );
  }

  if (!recipe) {
    return (
      <div className="recipe-page container page-enter">
        <ErrorState
          title="Recipe Not Found"
          message={
            isSharedRoute
              ? "The family recipe you're looking for isn't available."
              : "The recipe you're looking for doesn't exist in your local library."
          }
        />
        <div className="error-actions">
          <ButtonLink to="/" variant="primary">
            Back to Cookbook
          </ButtonLink>
        </div>
      </div>
    );
  }

  const ingredientGroups = (() => {
    const groups: Array<{
      ingredients: Array<{ key: string; text: string }>;
      key: string;
      section: string | null;
    }> = [];

    recipe.recipe.ingredients.forEach((ingredient, index) => {
      const section = ingredient.section?.trim() || null;
      const currentGroup = groups[groups.length - 1];

      if (!currentGroup || currentGroup.section !== section) {
        groups.push({
          ingredients: [],
          key: `${section ?? "ungrouped"}-${index}`,
          section
        });
      }

      groups[groups.length - 1]?.ingredients.push({
        key: `${index}-${ingredient.text}`,
        text: ingredient.text
      });
    });

    return groups;
  })();

  const sortedSteps = [...recipe.recipe.steps].sort((a, b) => a.index - b.index);
  const sourceHost = recipe.sourceHost || new URL(recipe.sourceUrl).hostname.replace(/^www\./i, "");
  const headerImageUrl = buildRecipeImageUrl(getRecipeImageOrNull(recipe.recipe.image), 1200);
  const hasAlternateUnits = hasAlternateIngredientUnits(recipe.recipe.ingredients);
  const hasUnscalable = hasUnscalableIngredients(recipe.recipe.ingredients);
  const hasNutrition =
    recipe.recipe.nutrition &&
    Object.values(recipe.recipe.nutrition).some((value) => value != null && value !== "");

  const handlePrint = () => {
    window.print();
  };

  const handleShare = async () => {
    if (!recipe) return;
    const shareData = {
      title: recipe.recipe.title,
      text: `Check out this recipe I found on LinkDish: ${recipe.recipe.title}`,
      url: recipe.sourceUrl
    };

    if (navigator.share) {
      try {
        await navigator.share(shareData);
      } catch (err) {
        // User cancelled or share failed; fallback to clipboard silently
        if (err instanceof Error && err.name !== "AbortError") {
          try {
            await navigator.clipboard.writeText(shareData.url);
            setActionMessage("Recipe link copied to clipboard.");
          } catch {
            // Clipboard not available
          }
        }
      }
    } else {
      try {
        await navigator.clipboard.writeText(shareData.url);
        setActionMessage("Recipe link copied to clipboard.");
      } catch {
        // Clipboard not available
      }
    }
  };

  const handleShareCard = async () => {
    if (!recipe) return;

    setActionLoading("shareCard");
    setActionMessage("");

    try {
      const blob = await createShareCardBlob({
        imageUrl: headerImageUrl,
        sourceHost: recipe.sourceHost,
        sourceUrl: recipe.sourceUrl,
        title: recipe.recipe.title
      });
      const file = new File([blob], getShareCardFilename(recipe.recipe.title), {
        type: "image/png"
      });
      const shareData: ShareData = {
        files: [file],
        text: `Get cooking with ${recipe.recipe.title}.`,
        title: recipe.recipe.title
      };

      if (navigator.share && navigator.canShare?.({ files: [file] })) {
        try {
          await navigator.share(shareData);
          return;
        } catch (err) {
          if (err instanceof Error && err.name === "AbortError") {
            return;
          }
        }
      }

      downloadBlob(blob, file.name);
      setActionMessage("Share card downloaded.");
    } catch (err) {
      console.error("Share card failed:", err);
      setActionMessage("Could not create the share card. Please try again.");
    } finally {
      setActionLoading(null);
    }
  };

  return (
    <div className="recipe-detail-page container page-enter">
      {actionMessage && (
        <div className="recipe-action-message" role="status">
          {actionMessage}
        </div>
      )}

      <div className="recipe-android-stack print-target">
        <header className="recipe-header">
          {headerImageUrl ? (
            <RecipeImageWithFallback
              src={headerImageUrl}
              imageClassName="recipe-header-image"
              fallback={null}
            />
          ) : null}
          <h1 className="recipe-title">{recipe.recipe.title}</h1>
          <p className="recipe-metadata">{buildRecipeMetaLine(recipe.recipe)}</p>
          <p className="recipe-source-line">
            From{" "}
            <a
              href={recipe.sourceUrl}
              target="_blank"
              rel="noreferrer"
              className="recipe-source-link"
            >
              {sourceHost}
            </a>
          </p>
          <RecipeScaleControls
            className="recipe-detail-scale-controls print-hide"
            hasAlternateUnits={hasAlternateUnits}
            hasUnscalableIngredients={hasUnscalable}
            onScalingChange={setRecipeScaling}
            scaling={recipeScaling}
            unitLabels={unitLabels}
          />
          <div className="detail-actions-top print-hide">
            <Button variant="ghost" onClick={() => navigate("/")}>
              <Icon name="arrow-left" size={18} /> Back to Cookbook
            </Button>
            <div className="detail-actions-group">
              {(!isSharedRoute || canEditSharedRecipe) && (
                <Button variant="outline" onClick={openEditor}>
                  <Icon name="pencil-outline" size={18} /> Edit
                </Button>
              )}
              <Button
                variant="outline"
                onClick={handleDuplicate}
                loading={actionLoading === "duplicate"}
              >
                <Icon name="content-copy" size={18} /> {isSharedRoute ? "Save copy" : "Duplicate"}
              </Button>
              {isAuthenticated && !isSharedRoute && (
                <Button variant="outline" onClick={handleSync} loading={actionLoading === "sync"}>
                  <Icon name="cloud-upload-outline" size={18} /> Sync
                </Button>
              )}
              <Button variant="outline" onClick={handleShare}>
                <Icon name="share-variant-outline" size={18} /> Share
              </Button>
              <Button variant="outline" onClick={() => void openShoppingSheet()}>
                <Icon name="basket-outline" size={18} /> Add to shopping list
              </Button>
              <Button
                variant="outline"
                onClick={handleShareCard}
                loading={actionLoading === "shareCard"}
              >
                <Icon name="image-outline" size={18} /> Share card
              </Button>
              <Button variant="outline" onClick={handlePrint}>
                <Icon name="printer-outline" size={18} /> Print Recipe
              </Button>
              {(!isSharedRoute || canEditSharedRecipe) && (
                <Button
                  variant="outline-danger"
                  onClick={() => setDeleteConfirmationVisible(true)}
                  loading={actionLoading === "delete"}
                >
                  <Icon name="delete-outline" size={18} /> {isSharedRoute ? "Unshare" : "Delete"}
                </Button>
              )}
            </div>
          </div>
          <div className="recipe-status-row print-hide">
            {recipe.sync?.status === "synced" && <Chip variant="accent">Synced</Chip>}
            {recipe.sync?.status === "dirty" && <Chip variant="default">Local edits</Chip>}
            {recipe.sync?.status === "sync_failed" && <Chip variant="default">Sync failed</Chip>}
            {sharedRecipe && (
              <Chip variant="accent">Owned by {getSharedRecipeOwnerLabel(sharedRecipe)}</Chip>
            )}
          </div>
        </header>

        {recipe.sourceImages?.length ? (
          <section className="recipe-section source-images-section print-hide">
            <h2 className="section-title">Source Scan</h2>
            <div className="source-image-grid">
              {recipe.sourceImages.map((image, index) => (
                <img
                  alt={`Scanned recipe source ${index + 1}`}
                  className="source-image-thumb"
                  key={`${image.mimeType}-${index}`}
                  src={image.dataUrl}
                />
              ))}
            </div>
          </section>
        ) : null}

        <section className="recipe-section recipe-ingredients-section">
          <h2 className="section-title">Ingredients</h2>
          <div className="recipe-list">
            {ingredientGroups.map((group) => (
              <div key={group.key} className="ingredient-group">
                {group.section ? (
                  <span className="ingredient-group-title">{group.section}</span>
                ) : null}
                {group.ingredients.map((ingredient) => (
                  <div key={ingredient.key} className="ingredient-row">
                    <span className="ingredient-bullet" aria-hidden="true" />
                    <span className="recipe-list-text">
                      {getScaledIngredientText(ingredient.text, recipeScaling)}
                    </span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </section>

        <section className="recipe-section recipe-steps-section">
          <div className="recipe-section-header print-hide">
            <h2 className="section-title">Method</h2>
            <CookMode
              onAddIngredientsToShoppingList={openShoppingSheet}
              onFinish={handleCookModeFinish}
              onScalingChange={setRecipeScaling}
              recipe={recipe.recipe}
              scaling={recipeScaling}
            />
          </div>
          <h2 aria-hidden="true" className="section-title screen-hidden-print-visible">
            Method
          </h2>
          <div className="recipe-list">
            {sortedSteps.map((step) => (
              <div key={step.index} className="step-item">
                <span className="step-number">{step.index}</span>
                <p className="recipe-list-text step-text">{step.text}</p>
              </div>
            ))}
          </div>
        </section>

        {recipe.notes && (
          <section className="recipe-section recipe-notes-card">
            <h2 className="section-title">Personal Notes</h2>
            <p className="recipe-notes-text">{recipe.notes}</p>
          </section>
        )}

        {hasNutrition && (
          <section className="recipe-section recipe-nutrition-section">
            <button
              aria-controls="recipe-nutrition-panel"
              aria-expanded={nutritionExpanded}
              className="nutrition-toggle"
              onClick={() => setNutritionExpanded((expanded) => !expanded)}
              type="button"
            >
              <span className="section-title">Nutrition</span>
              <Icon name={nutritionExpanded ? "chevron-up" : "chevron-down"} size={20} />
            </button>
            <div className="nutrition-grid" hidden={!nutritionExpanded} id="recipe-nutrition-panel">
              {nutritionRows
                .filter(
                  ([, key]) =>
                    recipe.recipe.nutrition?.[key] != null && recipe.recipe.nutrition?.[key] !== ""
                )
                .map(([label, key]) => (
                  <div key={key} className="nutrition-card">
                    <span className="nutrition-card-label">{label}</span>
                    <span className="nutrition-card-value">{recipe.recipe.nutrition?.[key]}</span>
                  </div>
                ))}
            </div>
          </section>
        )}

        {recipe.extraction.warnings.length > 0 && (
          <section className="recipe-section recipe-warnings-section print-hide">
            <h2 className="warnings-title">Extraction Notes</h2>
            <ul className="warnings-list">
              {recipe.extraction.warnings.map((warn, idx) => (
                <li key={idx} className="warning-item">
                  {warn}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>

      {editorOpen &&
        createPortal(
          <div className="recipe-editor-backdrop" role="presentation">
            <Card className="recipe-editor-modal" variant="default">
              <div className="recipe-editor-header">
                <h2>Edit Recipe</h2>
                <button
                  aria-label="Close editor"
                  className="recipe-editor-close"
                  onClick={() => setEditorOpen(false)}
                  type="button"
                >
                  <Icon name="close" size={20} />
                </button>
              </div>

              {editorError && (
                <div className="recipe-editor-error" role="alert">
                  {editorError}
                </div>
              )}

              <label className="recipe-editor-field">
                <span>Title</span>
                <input value={draftTitle} onChange={(event) => setDraftTitle(event.target.value)} />
              </label>

              <label className="recipe-editor-field">
                <span>Servings</span>
                <input
                  value={draftServings}
                  onChange={(event) => setDraftServings(event.target.value)}
                />
              </label>

              <label className="recipe-editor-field">
                <span>Ingredients</span>
                <textarea
                  value={draftIngredients}
                  onChange={(event) => setDraftIngredients(event.target.value)}
                  rows={8}
                />
              </label>

              <label className="recipe-editor-field">
                <span>Method</span>
                <textarea
                  value={draftSteps}
                  onChange={(event) => setDraftSteps(event.target.value)}
                  rows={8}
                />
              </label>

              <label className="recipe-editor-field">
                <span>Notes</span>
                <textarea
                  value={draftNotes}
                  onChange={(event) => setDraftNotes(event.target.value)}
                  rows={4}
                />
              </label>

              <div className="recipe-editor-actions">
                <Button onClick={handleSaveEdits} loading={actionLoading === "edit"}>
                  Save changes
                </Button>
                <Button variant="ghost" onClick={() => setEditorOpen(false)}>
                  Cancel
                </Button>
              </div>
            </Card>
          </div>,
          document.body
        )}

      {shoppingSheetOpen && (
        <AddRecipeToShoppingSheet
          canSync={shoppingCanSync}
          onAdded={(count) => {
            setActionMessage(
              shoppingCanSync
                ? `${count} item${count === 1 ? "" : "s"} added to your household shopping list.`
                : `${count} item${count === 1 ? "" : "s"} added to your local shopping list.`
            );
          }}
          onClose={() => setShoppingSheetOpen(false)}
          recipe={recipe.recipe}
          recipeId={isSharedRoute && sharedRecipe ? sharedRecipe.id : recipe.id}
          scaling={recipeScaling}
          userId={user?.id}
        />
      )}

      <ConfirmationDialog
        cancelLabel={isSharedRoute ? "Keep shared" : "Keep recipe"}
        confirmLabel={isSharedRoute ? "Unshare" : "Delete"}
        confirmLoading={actionLoading === "delete"}
        message={
          isSharedRoute
            ? `Remove “${recipe.recipe.title}” from your Family recipe book?`
            : `“${recipe.recipe.title}” will be deleted from this device.`
        }
        onCancel={() => setDeleteConfirmationVisible(false)}
        onConfirm={() => {
          void handleDeleteRecipe();
        }}
        title={isSharedRoute ? "Unshare recipe?" : "Delete recipe?"}
        visible={deleteConfirmationVisible}
      />
    </div>
  );
};
