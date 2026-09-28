import React, { Suspense, useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import { useAuth } from "../../auth/AuthProvider";
import { Button } from "../../components/Button";
import { Chip } from "../../components/Chip";
import { Icon } from "../../components/Icon";
import { IconButton } from "../../components/IconButton";
import { Menu } from "../../components/Menu";
import { Sheet } from "../../components/Sheet";
import { useHideTabBar } from "../../components/tab-bar-visibility";
import { useDocumentTitle } from "../../lib/use-document-title";
import { RAIL_MEDIA_QUERY, useMediaQuery } from "../../lib/use-media-query";
import { lazyWithRetry } from "../../platform/lazy";
import { OptionalChunkBoundary } from "../../platform/OptionalChunkBoundary";
import { LazyCookMode, preloadCookMode } from "../cook-mode/LazyCookMode";
import { useRecipeScaling } from "../recipe-view/recipe-scaling";
import { getRecipeSourceInfo } from "../recipe-view/recipe-source";
import { RecipeActionBar } from "../recipe-view/RecipeActionBar";
import { RecipeView } from "../recipe-view/RecipeView";
import { useIngredientChecks } from "../recipe-view/use-ingredient-checks";

import { getFriendlyImportNotes } from "./import-outcome";
import { useSaveImport } from "./use-save-import";

import type { HouseholdShareStatus } from "./use-save-import";
import type { MenuEntry } from "../../components/Menu";
import type { WebSavedRecipe } from "../library/saved-recipe-types";
import type {
  ExtractRecipeImage,
  ExtractionProvenance,
  ExtractionStrategy,
  FetchMode
} from "@linkdish/api-contracts";
import type { Recipe } from "@linkdish/recipe-domain";

import "./ExtractResult.css";

const AddToPlanSheet = lazyWithRetry(() =>
  import("../plan/AddToPlanSheet").then((module) => ({ default: module.AddToPlanSheet }))
);
const AddRecipeToShoppingSheet = lazyWithRetry(() =>
  import("../shopping/AddRecipeToShoppingSheet").then((module) => ({
    default: module.AddRecipeToShoppingSheet
  }))
);

export interface ExtractResultProps {
  recipe: Recipe;
  sourceUrl: string;
  sourceImages?: ExtractRecipeImage[] | undefined;
  extraction: {
    fetchMode: FetchMode;
    provenance: ExtractionProvenance[];
    strategy: ExtractionStrategy;
    warnings: string[];
  };
  /** From the API's diagnostics; used for gentle "worth a look" notes. */
  confidenceScore?: number | undefined;
  missingFields?: readonly string[] | undefined;
  /** "Import another": back to an empty importer. */
  onReset: () => void;
  /** Called after the recipe is written to the cookbook. */
  onSaved?: ((recipe: WebSavedRecipe) => void) | undefined;
  /** Called when the person throws an unsaved import away. */
  onDiscard?: (() => void) | undefined;
  /** Shown above the recipe (e.g. "This recipe was waiting for you"). */
  notice?: React.ReactNode;
}

type OpenSheet = "shopping" | "plan" | "leave" | null;

const TEXT_IMPORT_URL_FRAGMENT = "linkdish.app/text-imports/";

const HouseholdChip: React.FC<{ status: HouseholdShareStatus; onRetry: () => void }> = ({
  status,
  onRetry
}) => {
  if (status === "sharing") {
    return (
      <span className="extract-result-household is-busy" role="status">
        <Icon className="extract-result-spin" name="loader" size={14} /> Sharing with your
        household…
      </span>
    );
  }

  if (status === "shared") {
    return (
      <span className="extract-result-household is-shared" role="status">
        <Icon name="users" size={14} /> Shared with your household
      </span>
    );
  }

  if (status === "failed") {
    return (
      <button className="extract-result-household is-failed" onClick={onRetry} type="button">
        <Icon name="cloud-off" size={14} /> Couldn’t share with your household · Retry
      </button>
    );
  }

  return null;
};

/**
 * A freshly imported recipe, shown exactly like a saved one (scaling, units, tick-off, method,
 * nutrition) with one primary action: Save to cookbook. Once saved, the next steps take over:
 * start cooking, add to the shopping list or the plan, open it, or import another.
 */
export const ExtractResult: React.FC<ExtractResultProps> = ({
  recipe,
  sourceUrl,
  sourceImages,
  extraction,
  confidenceScore,
  missingFields,
  onReset,
  onSaved,
  onDiscard,
  notice
}) => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const isDesktop = useMediaQuery(RAIL_MEDIA_QUERY);
  const [cookOpen, setCookOpen] = useState(false);
  const [openSheet, setOpenSheet] = useState<OpenSheet>(null);
  const saveInput = useMemo(
    () => ({ extraction, recipe, sourceImages, sourceUrl }),
    [extraction, recipe, sourceImages, sourceUrl]
  );
  const saving = useSaveImport(saveInput, { onSaved });
  const isSaved = saving.status === "saved";
  const isBusy = saving.status === "saving";
  const isTextImport = sourceUrl.includes(TEXT_IMPORT_URL_FRAGMENT);
  // The same source line (and icon) the recipe page will show once it's saved.
  const source = useMemo(() => getRecipeSourceInfo(sourceUrl), [sourceUrl]);
  const scaling = useRecipeScaling(recipe);
  // The cookbook id is known before saving, so ticks and timers carry over once it's saved.
  const sessionKey = saving.recipeId ?? `import:${sourceUrl}`;
  const checks = useIngredientChecks(saving.recipeId);
  const recipeHref = isSaved && saving.recipeId ? `/recipes/${saving.recipeId}` : "/import";
  const timerContext = useMemo(
    () => ({ href: recipeHref, recipeTitle: recipe.title, sessionKey }),
    [recipe.title, recipeHref, sessionKey]
  );
  const notes = useMemo(
    () =>
      getFriendlyImportNotes({
        confidenceScore,
        missingFields,
        sourceKind: source.kind === "photos" ? "photos" : isTextImport ? "text" : "web",
        strategy: extraction.strategy,
        warnings: extraction.warnings
      }),
    [
      confidenceScore,
      extraction.strategy,
      extraction.warnings,
      isTextImport,
      missingFields,
      source.kind
    ]
  );

  useDocumentTitle(recipe.title);
  // Like the recipe page: the floating action bar replaces the phone tab bar while the result
  // is on screen ("Import another" goes back), so two bottom bars never stack.
  useHideTabBar();

  const openRecipe = useCallback(() => {
    if (saving.recipeId) {
      void navigate(`/recipes/${saving.recipeId}`);
    }
  }, [navigate, saving.recipeId]);

  const requestImportAnother = () => {
    if (isSaved) {
      onReset();
      return;
    }

    setOpenSheet("leave");
  };

  const saveAndLeave = async () => {
    const saved = await saving.save();

    if (saved) {
      setOpenSheet(null);
      onReset();
    } else {
      setOpenSheet(null);
    }
  };

  const discard = () => {
    setOpenSheet(null);
    onDiscard?.();
    onReset();
  };

  const closeSheet = () => setOpenSheet(null);

  /* ----------------------------------------- actions ---------------------------------------- */

  const saveButton = (
    <Button
      className="extract-result-save"
      icon="bookmark-plus"
      loading={isBusy}
      onClick={() => void saving.save()}
      size="lg"
      variant="primary"
    >
      Save to cookbook
    </Button>
  );

  const startCookingButton = (
    <Button
      className="extract-result-cook"
      icon="chef-hat"
      onClick={() => setCookOpen(true)}
      onFocus={preloadCookMode}
      onPointerEnter={preloadCookMode}
      size="lg"
      variant={isSaved ? "primary" : "secondary"}
    >
      Start cooking
    </Button>
  );

  const moreItems: MenuEntry[] = [
    { icon: "book-open", id: "open", label: "Open in cookbook", onSelect: openRecipe },
    {
      icon: "calendar-plus",
      id: "plan",
      label: "Add to meal plan…",
      onSelect: () => setOpenSheet("plan")
    },
    { id: "separator", type: "separator" },
    { icon: "plus", id: "another", label: "Import another", onSelect: onReset }
  ];

  const moreMenu = (
    <Menu
      align="end"
      items={moreItems}
      label="More for this recipe"
      presentation="adaptive"
      renderTrigger={(triggerProps) => (
        <IconButton
          {...triggerProps}
          aria-label="More actions"
          icon="more-horizontal"
          size={isDesktop ? "md" : "lg"}
          variant="tonal"
        />
      )}
      sheetTitle={recipe.title}
    />
  );

  const heroActions = isDesktop ? (
    isSaved ? (
      <>
        {startCookingButton}
        <Button
          icon="shopping-basket"
          onClick={() => setOpenSheet("shopping")}
          size="lg"
          variant="secondary"
        >
          Add to shopping list
        </Button>
        {moreMenu}
      </>
    ) : (
      <>
        {saveButton}
        {startCookingButton}
      </>
    )
  ) : undefined;

  // Once saved, the "Saved to your cookbook" card says it; no second chip repeating it.
  const eyebrow = isSaved ? undefined : (
    <Chip icon="sparkles" size="sm" variant="butter">
      Just imported
    </Chip>
  );

  /* ----------------------------------------- banner ----------------------------------------- */

  const banner = (
    <>
      {notice}
      {saving.status === "duplicate" ? (
        <section aria-live="polite" className="extract-result-banner is-duplicate">
          <span aria-hidden="true" className="extract-result-banner-icon">
            <Icon name="bookmark-check" size={20} />
          </span>
          <div className="extract-result-banner-copy">
            <p className="extract-result-banner-title">You saved this one before</p>
            <p className="extract-result-banner-text">
              Keep your copy, or replace it with this fresh import. Your notes and favorites stay.
            </p>
          </div>
          <div className="extract-result-banner-actions">
            <Button onClick={openRecipe} size="sm" variant="secondary">
              Open my copy
            </Button>
            <Button
              loading={isBusy}
              onClick={() => void saving.replace()}
              size="sm"
              variant="tonal"
            >
              Replace it
            </Button>
          </div>
        </section>
      ) : null}
      {saving.status === "error" || saving.status === "limit" ? (
        <p className="extract-result-alert" role="alert">
          <Icon name="alert-circle" size={18} />
          {saving.error}
        </p>
      ) : null}
      {isSaved ? (
        <section aria-live="polite" className="extract-result-banner is-saved">
          <span aria-hidden="true" className="extract-result-banner-icon">
            <Icon name="check" size={20} strokeWidth={2.6} />
          </span>
          <div className="extract-result-banner-copy">
            <p className="extract-result-banner-title">Saved to your cookbook</p>
            <p className="extract-result-banner-text">
              {saving.household === "none" || saving.household === "checking" ? (
                "Cook it now, add it to your week or grab the groceries."
              ) : (
                <HouseholdChip onRetry={saving.retryShare} status={saving.household} />
              )}
            </p>
          </div>
          <div className="extract-result-banner-actions">
            <Button icon="book-open" onClick={openRecipe} size="sm">
              Open recipe
            </Button>
            <Button icon="plus" onClick={onReset} size="sm" variant="ghost">
              Import another
            </Button>
          </div>
        </section>
      ) : null}
    </>
  );

  return (
    <div
      className={`extract-result page-enter${isDesktop ? " is-desktop" : ""}${
        recipe.image?.url ? " has-hero-image" : ""
      }`}
    >
      {/* Before saving this is the way back (it asks first); once saved, the card offers
          "Import another", so it isn't shown twice. */}
      {isSaved ? null : (
        <div className="extract-result-toolbar">
          <Button
            className="extract-result-back"
            icon="arrow-left"
            onClick={requestImportAnother}
            size="sm"
            variant="ghost"
          >
            Import another
          </Button>
        </div>
      )}

      <RecipeView
        banner={banner}
        checks={checks}
        heroActions={heroActions}
        heroEyebrow={eyebrow}
        recipe={recipe}
        scaling={scaling}
        source={source}
        sourceImages={sourceImages}
        timerContext={timerContext}
        warnings={notes}
      />

      {!isDesktop ? (
        <RecipeActionBar label={isSaved ? "Recipe actions" : "Save this recipe"}>
          {isSaved ? (
            <>
              {startCookingButton}
              <IconButton
                aria-label="Add to shopping list"
                icon="shopping-basket"
                onClick={() => setOpenSheet("shopping")}
                size="lg"
                variant="tonal"
              />
              {moreMenu}
            </>
          ) : (
            <>
              {saveButton}
              <IconButton
                aria-label="Start cooking"
                icon="chef-hat"
                onClick={() => setCookOpen(true)}
                onPointerEnter={preloadCookMode}
                size="lg"
                variant="tonal"
              />
            </>
          )}
        </RecipeActionBar>
      ) : null}

      <LazyCookMode
        entryPoint="import_result"
        onAddIngredientsToShoppingList={isSaved ? () => setOpenSheet("shopping") : undefined}
        onClose={() => setCookOpen(false)}
        open={cookOpen}
        recipe={recipe}
        recipeHref={recipeHref}
        scaling={scaling}
        sessionKey={sessionKey}
      />

      {saving.recipeId && (openSheet === "shopping" || openSheet === "plan") ? (
        <OptionalChunkBoundary key={openSheet} name="Recipe organiser" onError={closeSheet}>
          <Suspense fallback={null}>
            {openSheet === "shopping" ? (
              <AddRecipeToShoppingSheet
                onClose={closeSheet}
                recipe={recipe}
                recipeId={saving.recipeId}
                scaling={scaling.state}
                userId={user?.id}
              />
            ) : (
              <AddToPlanSheet
                onClose={closeSheet}
                open
                recipeId={saving.recipeId}
                recipeTitle={recipe.title}
              />
            )}
          </Suspense>
        </OptionalChunkBoundary>
      ) : null}

      <Sheet
        description={`“${recipe.title}” isn’t in your cookbook yet.`}
        footer={
          <>
            <Button onClick={discard} variant="ghost">
              Discard
            </Button>
            <Button icon="bookmark-plus" loading={isBusy} onClick={() => void saveAndLeave()}>
              Save it
            </Button>
          </>
        }
        onClose={closeSheet}
        open={openSheet === "leave"}
        size="sm"
        title="Keep this recipe?"
      >
        <p className="extract-result-leave-copy">
          Save it now and it’ll be waiting in your cookbook. Discard it and you can always import
          the link again.
        </p>
      </Sheet>
    </div>
  );
};
