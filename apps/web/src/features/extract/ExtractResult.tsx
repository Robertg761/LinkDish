import React, { useState } from "react";

import { trackWebV2AnalyticsEvent } from "../../analytics/client";
import { useAuth } from "../../auth/AuthProvider";
import { Button } from "../../components/Button";
import { Icon } from "../../components/Icon";
import { RecipeImageWithFallback } from "../../components/RecipeImageWithFallback";
import { requestSaveFeedback } from "../../lib/delight-events";
import { buildRecipeImageUrl, getRecipeImageOrNull } from "../../lib/recipe-image";
import { saveRecipe, forceSaveRecipe, syncRecipeToHousehold } from "../library/saved-recipe-store";
import { CookMode } from "../recipes/CookMode";
import { buildRecipeMetaLine } from "../recipes/recipe-meta";
import { useUpgradeSheet } from "../upgrade/UpgradeSheet";

import type {
  ExtractRecipeImage,
  FetchMode,
  ExtractionProvenance,
  ExtractionStrategy
} from "@linkdish/api-contracts";
import type { Recipe } from "@linkdish/recipe-domain";
import "./ExtractResult.css";

interface ExtractResultProps {
  recipe: Recipe;
  sourceUrl: string;
  sourceImages?: ExtractRecipeImage[] | undefined;
  extraction: {
    fetchMode: FetchMode;
    provenance: ExtractionProvenance[];
    strategy: ExtractionStrategy;
    warnings: string[];
  };
  onReset: () => void;
}

const prefersReducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const parseSafeSourceUrl = (value: string): URL | null => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed : null;
  } catch {
    return null;
  }
};

export const ExtractResult: React.FC<ExtractResultProps> = ({
  recipe,
  sourceUrl,
  sourceImages,
  extraction,
  onReset
}) => {
  const { isAuthenticated, user } = useAuth();
  const { requestUpgradeSheet } = useUpgradeSheet();
  const [saveStatus, setSaveStatus] = useState<
    "idle" | "saving" | "syncing" | "saved" | "error" | "duplicate_prompt"
  >("idle");
  const [errorMessage, setErrorMessage] = useState("");
  const [syncWarning, setSyncWarning] = useState("");
  const [saveFeedbackActive, setSaveFeedbackActive] = useState(false);
  const [nutritionExpanded, setNutritionExpanded] = useState(true);

  const isPremium = user?.billingPlan === "plus" || user?.billingPlan === "family";
  const safeSourceUrl = parseSafeSourceUrl(sourceUrl);
  const sourceHost = safeSourceUrl?.hostname.replace(/^www\./i, "") || "Unknown source";
  const previewImageUrl = buildRecipeImageUrl(getRecipeImageOrNull(recipe.image), 1200);
  const hasNutrition =
    recipe.nutrition && Object.values(recipe.nutrition).some((v) => v != null && v !== "");

  const playSaveFeedback = () => {
    requestSaveFeedback();

    if (prefersReducedMotion()) {
      return;
    }

    setSaveFeedbackActive(false);
    requestAnimationFrame(() => {
      setSaveFeedbackActive(true);
    });
  };

  const handleSave = async () => {
    setSaveStatus("saving");
    setErrorMessage("");
    setSyncWarning("");

    try {
      const res = await saveRecipe(
        {
          recipe,
          sourceUrl,
          sourceImages,
          extraction
        },
        isPremium
      );

      if (res.success) {
        trackWebV2AnalyticsEvent({
          name: "recipe_saved",
          routeOrScreen: "/",
          properties: {
            source_type: sourceImages?.length ? "image" : "url",
            surface: "import_result"
          }
        });

        if (isAuthenticated && res.recipe) {
          setSaveStatus("syncing");
          const syncedRecipe = await syncRecipeToHousehold(res.recipe);

          if (syncedRecipe.sync?.status === "sync_failed") {
            setSyncWarning(
              "Saved in Library. Household sync failed, but you can retry from the Library."
            );
          }
        }

        setSaveStatus("saved");
        playSaveFeedback();
        // Trigger local PWA install flag
        localStorage.setItem("linkdish:web:has-extracted-recipe", "true");
      } else {
        if (res.error === "limit_exceeded") {
          setSaveStatus("error");
          setErrorMessage(
            "Your free cookbook is full - 15 recipes saved. Upgrade for unlimited saved recipes."
          );
          requestUpgradeSheet("save_limit");
        } else if (res.error === "duplicate_prompt") {
          setSaveStatus("duplicate_prompt");
        }
      }
    } catch (err) {
      console.error("Save error:", err);
      setSaveStatus("error");
      setErrorMessage("Could not save recipe to IndexedDB.");
    }
  };

  const handleForceSave = async () => {
    setSaveStatus("saving");
    setErrorMessage("");
    setSyncWarning("");

    try {
      const savedRecipe = await forceSaveRecipe({
        recipe,
        sourceUrl,
        sourceImages,
        extraction
      });

      trackWebV2AnalyticsEvent({
        name: "recipe_saved",
        routeOrScreen: "/",
        properties: {
          source_type: sourceImages?.length ? "image" : "url",
          surface: "import_result"
        }
      });

      if (isAuthenticated) {
        setSaveStatus("syncing");
        const syncedRecipe = await syncRecipeToHousehold(savedRecipe);

        if (syncedRecipe.sync?.status === "sync_failed") {
          setSyncWarning(
            "Saved in Library. Household sync failed, but you can retry from the Library."
          );
        }
      }

      setSaveStatus("saved");
      playSaveFeedback();
    } catch (err) {
      console.error("Force save error:", err);
      setSaveStatus("error");
      setErrorMessage("Could not overwrite the recipe.");
    }
  };

  // Group ingredients by section
  const ingredientSections = React.useMemo(() => {
    const sections: Record<string, typeof recipe.ingredients> = {};
    const defaultSectionName = "Ingredients";

    recipe.ingredients.forEach((ing) => {
      const secName = ing.section ? ing.section.trim() : defaultSectionName;
      if (!sections[secName]) {
        sections[secName] = [];
      }
      sections[secName].push(ing);
    });

    return sections;
  }, [recipe.ingredients]);

  return (
    <div className="extract-result animate-fade-in">
      {saveStatus === "syncing" && (
        <div className="result-banner" role="status">
          Saving locally and syncing to your household.
        </div>
      )}

      {saveStatus === "error" && (
        <div className="result-banner error-banner" role="alert">
          {errorMessage}
        </div>
      )}

      {syncWarning && (
        <div className="result-banner warning-banner" role="status">
          {syncWarning}
        </div>
      )}

      <article
        aria-labelledby="extract-result-title"
        className={`recipe-detail ${saveFeedbackActive ? "recipe-detail-save-pulse" : ""}`}
        onAnimationEnd={() => setSaveFeedbackActive(false)}
      >
        <header className="recipe-header">
          {previewImageUrl ? (
            <RecipeImageWithFallback
              src={previewImageUrl}
              imageClassName="extract-result-image"
              fallback={null}
            />
          ) : null}
          <h1 className="recipe-title" id="extract-result-title">
            {recipe.title}
          </h1>
          <p className="recipe-metadata">{buildRecipeMetaLine(recipe)}</p>
          <p className="recipe-source-line">
            From{" "}
            {safeSourceUrl ? (
              <a
                href={safeSourceUrl.href}
                target="_blank"
                rel="noreferrer"
                className="recipe-source-link"
              >
                {sourceHost}
              </a>
            ) : (
              sourceHost
            )}
          </p>
          <div className="result-actions-top">
            <Button variant="ghost" onClick={onReset}>
              <Icon name="arrow-left" size={18} /> Import Another
            </Button>
            {saveStatus === "saved" ? (
              <Button variant="outline" disabled>
                <Icon name="bookmark-check-outline" size={18} /> Saved in Library
              </Button>
            ) : saveStatus === "duplicate_prompt" ? (
              <div className="duplicate-actions">
                <span className="duplicate-msg">Recipe already exists. Overwrite?</span>
                <Button variant="outline-danger" onClick={handleForceSave}>
                  Yes, Overwrite
                </Button>
                <Button variant="ghost" onClick={() => setSaveStatus("idle")}>
                  Cancel
                </Button>
              </div>
            ) : (
              <Button
                variant="primary"
                onClick={handleSave}
                loading={saveStatus === "saving" || saveStatus === "syncing"}
              >
                <Icon name="bookmark-plus-outline" size={18} /> Save Recipe
              </Button>
            )}
          </div>
        </header>

        {sourceImages?.length ? (
          <section className="recipe-section source-images-section">
            <h2 className="section-title">Source Scan</h2>
            <div className="source-image-grid">
              {sourceImages.map((image, index) => (
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
          {Object.entries(ingredientSections).map(([secName, ings]) => (
            <div key={secName} className="ingredient-group">
              {secName !== "Ingredients" && <h3 className="ingredient-group-title">{secName}</h3>}
              <ul className="ingredients-list">
                {ings.map((ing, idx) => (
                  <li key={idx} className="ingredient-item">
                    {ing.text}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>

        <section className="recipe-section recipe-steps-section">
          <div className="recipe-section-header">
            <h2 className="section-title">Method</h2>
            <CookMode recipe={recipe} />
          </div>
          <ol className="steps-list">
            {[...recipe.steps]
              .sort((a, b) => a.index - b.index)
              .map((step) => (
                <li key={step.index} className="step-item">
                  <span className="step-number">{step.index}</span>
                  <p className="step-text">{step.text}</p>
                </li>
              ))}
          </ol>
        </section>

        {hasNutrition && (
          <section className="recipe-section recipe-nutrition-section">
            <button
              aria-controls="extract-nutrition-panel"
              aria-expanded={nutritionExpanded}
              className="nutrition-toggle"
              onClick={() => setNutritionExpanded((expanded) => !expanded)}
              type="button"
            >
              <span className="section-title">Nutrition</span>
              <Icon name={nutritionExpanded ? "chevron-up" : "chevron-down"} size={20} />
            </button>
            <div
              className="nutrition-grid"
              hidden={!nutritionExpanded}
              id="extract-nutrition-panel"
            >
              {(
                [
                  ["Calories", "calories"],
                  ["Protein", "protein"],
                  ["Carbohydrates", "carbohydrates"],
                  ["Fat", "fat"],
                  ["Fiber", "fiber"],
                  ["Sugar", "sugar"],
                  ["Sodium", "sodium"]
                ] as const
              )
                .filter(
                  ([, key]) => recipe.nutrition?.[key] != null && recipe.nutrition?.[key] !== ""
                )
                .map(([label, key]) => (
                  <div key={key} className="nutrition-card">
                    <span className="nutrition-card-label">{label}</span>
                    <span className="nutrition-card-value">{recipe.nutrition?.[key]}</span>
                  </div>
                ))}
            </div>
          </section>
        )}

        {extraction.warnings.length > 0 && (
          <section className="recipe-section recipe-warnings-section">
            <h4 className="warnings-title">Extraction Notes</h4>
            <ul className="warnings-list">
              {extraction.warnings.map((warn, idx) => (
                <li key={idx} className="warning-item">
                  {warn}
                </li>
              ))}
            </ul>
          </section>
        )}
      </article>
    </div>
  );
};
