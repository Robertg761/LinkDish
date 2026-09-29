import React, { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { Button, ButtonLink } from "../../components/Button";
import { ConfirmationDialog } from "../../components/ConfirmationDialog";
import { EmptyState } from "../../components/EmptyState";
import { Icon } from "../../components/Icon";
import { useDocumentTitle } from "../../lib/use-document-title";
import { RAIL_MEDIA_QUERY, useMediaQuery } from "../../lib/use-media-query";
import { LazyCookMode, preloadCookMode } from "../cook-mode/LazyCookMode";
import { useRecipeScaling } from "../recipe-view/recipe-scaling";
import { getRecipeSourceInfo } from "../recipe-view/recipe-source";
import { RecipeActionBar } from "../recipe-view/RecipeActionBar";
import { RecipeView } from "../recipe-view/RecipeView";
import { useIngredientChecks } from "../recipe-view/use-ingredient-checks";

import { getFeaturedRecipeBySlug } from "./featured-recipes";
import { useMetaDescription } from "./use-meta-description";
import { useSaveFeaturedRecipe } from "./use-save-featured-recipe";

import type { FeaturedRecipe } from "./types";

import "./FeaturedRecipePage.css";

/** Marketing landing pages linked from linkdish.ca: a real recipe, shown the LinkDish way. */
export const FeaturedRecipePage: React.FC = () => {
  const { slug } = useParams<{ slug?: string }>();
  const featured = getFeaturedRecipeBySlug(slug);

  if (!featured) {
    return <FeaturedNotFound />;
  }

  return <FeaturedRecipeScreen featured={featured} key={featured.slug} />;
};

const FeaturedNotFound: React.FC = () => {
  useDocumentTitle("Featured recipe not found");

  return (
    <div className="featured-page is-empty page-enter">
      <EmptyState
        actions={
          <ButtonLink icon="link" to="/import" variant="primary">
            Import a recipe
          </ButtonLink>
        }
        body="That featured LinkDish recipe is no longer available. Paste any recipe link to see what LinkDish does with it."
        illustration="search"
        title="Featured recipe not found"
      />
    </div>
  );
};

const FeaturedRecipeScreen: React.FC<{ featured: FeaturedRecipe }> = ({ featured }) => {
  const { recipe } = featured;
  const navigate = useNavigate();
  const isDesktop = useMediaQuery(RAIL_MEDIA_QUERY);
  const [cookOpen, setCookOpen] = useState(false);
  const source = useMemo(() => getRecipeSourceInfo(featured.sourceUrl), [featured.sourceUrl]);
  const scaling = useRecipeScaling(recipe);
  const sessionKey = `featured:${featured.slug}`;
  const checks = useIngredientChecks(sessionKey);
  const timerContext = useMemo(
    () => ({ href: `/featured/${featured.slug}`, recipeTitle: recipe.title, sessionKey }),
    [featured.slug, recipe.title, sessionKey]
  );
  const saving = useSaveFeaturedRecipe(featured);
  const isBusy = saving.status === "saving" || saving.status === "syncing";
  const isSaved = saving.status === "saved";

  useDocumentTitle(recipe.title);
  useMetaDescription(
    `${recipe.title}, saved from ${source.label} with LinkDish: just the recipe, no ads. Scale it, switch units and cook it step by step.`
  );

  const openSaved = () => {
    if (saving.savedRecipeId) {
      void navigate(`/recipes/${saving.savedRecipeId}`);
    }
  };

  const saveButton = isSaved ? (
    <Button
      icon="bookmark-check"
      onClick={openSaved}
      size="lg"
      variant="tonal"
      disabled={!saving.savedRecipeId}
    >
      In your cookbook
    </Button>
  ) : (
    <Button
      icon="bookmark-plus"
      loading={isBusy}
      onClick={() => void saving.save()}
      size="lg"
      variant="primary"
    >
      Save to my cookbook
    </Button>
  );

  // Save problems stay right under the recipe header, where the save button is.
  const alerts =
    saving.error || saving.syncWarning ? (
      <div className="featured-alerts print-hide">
        {saving.error ? (
          <p className="featured-banner-alert" role="alert">
            {saving.error}
          </p>
        ) : null}
        {saving.syncWarning ? (
          <p className="featured-banner-alert" role="status">
            {saving.syncWarning}
          </p>
        ) : null}
      </div>
    ) : null;

  // The LinkDish pitch comes after the recipe, so the ingredients are on the first screen.
  const promo = (
    <aside className="featured-banner print-hide" aria-labelledby="featured-banner-title">
      <span aria-hidden="true" className="featured-banner-mark">
        <Icon name="sparkles" size={20} />
      </span>
      <div className="featured-banner-copy">
        <p className="featured-banner-title" id="featured-banner-title">
          Saved from <strong>{source.label}</strong> with{" "}
          <span className="accent-word">LinkDish</span>
        </p>
        <p className="featured-banner-text">
          Paste any recipe link and LinkDish keeps just the recipe: no ads, no life story. Then
          scale it, switch units and cook it step by step.
        </p>
      </div>
      <div className="featured-banner-actions">
        <ButtonLink icon="link" to="/import" variant="secondary">
          Import your own recipe
        </ButtonLink>
      </div>
    </aside>
  );

  return (
    <div className={`featured-page page-enter${isDesktop ? " is-desktop" : ""}`}>
      <RecipeView
        banner={alerts}
        checks={checks}
        footer={
          <>
            {promo}
            <p className="featured-footer print-hide">
              Recipe and photo © {source.label}.{" "}
              {source.href ? (
                <a href={source.href} rel="noopener noreferrer" target="_blank">
                  Read the original
                </a>
              ) : null}{" "}
              · <Link to="/import">Save your own recipes with LinkDish</Link>
            </p>
          </>
        }
        heroActions={
          isDesktop ? (
            <>
              {saveButton}
              <Button
                icon="chef-hat"
                onClick={() => setCookOpen(true)}
                onPointerEnter={preloadCookMode}
                size="lg"
                variant="secondary"
              >
                Start cooking
              </Button>
            </>
          ) : undefined
        }
        recipe={recipe}
        scaling={scaling}
        source={source}
        timerContext={timerContext}
      />

      {!isDesktop ? (
        <RecipeActionBar>
          {saveButton}
          <Button
            aria-label="Start cooking"
            icon="chef-hat"
            onClick={() => setCookOpen(true)}
            onPointerEnter={preloadCookMode}
            size="lg"
            variant="tonal"
          >
            Cook
          </Button>
        </RecipeActionBar>
      ) : null}

      <LazyCookMode
        onClose={() => setCookOpen(false)}
        open={cookOpen}
        recipe={recipe}
        recipeHref={`/featured/${featured.slug}`}
        scaling={scaling}
        sessionKey={sessionKey}
      />

      <ConfirmationDialog
        cancelLabel="Keep mine"
        confirmLabel="Replace"
        confirmLoading={isBusy}
        confirmVariant="primary"
        message="You already saved this recipe. Replace your copy with this version? Your notes and favorites stay."
        onCancel={saving.dismissDuplicate}
        onConfirm={() => void saving.replace()}
        title="Already in your cookbook"
        visible={saving.status === "duplicate"}
      />
    </div>
  );
};
