import React, { useEffect, useState } from "react";

import { Badge } from "../../../components/Badge";
import { Icon } from "../../../components/Icon";
import { Illustration } from "../../../components/illustrations";
import { RecipeCard } from "../../../components/RecipeCard";
import { afterNextPaint } from "../../../platform/boot-settle";
import { importWithRetry } from "../../../platform/lazy";

import { LIBRARY_SHELF_CARD_SIZES, LibraryShelf } from "./LibraryShelf";
import { PasteLinkForm } from "./PasteLinkForm";
import { CompactRecipeMeta } from "./RecipeMeta";

import type { IconName } from "../../../components/Icon";
import type { FeaturedRecipe } from "../../featured/types";

import "./LibraryWelcome.css";

const HOW_IT_WORKS: ReadonlyArray<{ icon: IconName; title: string; body: string }> = [
  {
    body: "From any recipe site, YouTube, TikTok or Instagram.",
    icon: "link",
    title: "Paste a link"
  },
  {
    body: "Just the ingredients and steps. No life story, no pop-ups.",
    icon: "sparkles",
    title: "We tidy it up"
  },
  {
    body: "Cook mode with timers, then one tidy shopping list.",
    icon: "chef-hat",
    title: "Cook and shop"
  }
];

/* ------------------------------------------------------------------------------------------------
 * Sample recipes
 *
 * The samples (~25 KB of recipe data) are their own chunk, so they never hold up the welcome: a
 * new cook's first paint is the welcome and the starter recipes, with the "Try a sample" shelf
 * drawn as placeholder cards of the final size, filled in once the samples arrive. Nothing
 * below the shelf moves when they do. Cooks with recipes of their own never load them.
 * ---------------------------------------------------------------------------------------------- */

let samples: readonly FeaturedRecipe[] | null = null;
let samplesLoad: Promise<readonly FeaturedRecipe[]> | null = null;

/** Loads the sample recipes once (a failed load is tried again on the next call). */
export const loadWelcomeSamples = (): Promise<readonly FeaturedRecipe[]> => {
  samplesLoad ??= importWithRetry(() => import("../../featured/featured-recipes")).then(
    (module) => {
      samples = module.featuredRecipes;
      return samples;
    },
    (error: unknown) => {
      samplesLoad = null;
      throw error;
    }
  );

  return samplesLoad;
};

/** Enough placeholder cards to fill the shelf's visible width at every breakpoint. */
const PLACEHOLDER_CARDS = 5;

/**
 * A card-shaped placeholder built like a sample card (a 4:3 photo box, two title lines and a
 * meta line, as text of the same font), so the shelf keeps its exact height when the samples
 * replace it. Some sample titles always take two lines.
 */
const SamplePlaceholder: React.FC = () => (
  <li aria-hidden="true">
    <div className="recipe-card recipe-card-grid library-shelf-card library-welcome-sample-placeholder">
      <div className="recipe-card-media">
        <span className="skeleton library-welcome-sample-photo" />
      </div>
      <div className="recipe-card-body">
        <p className="recipe-card-title">
          <span className="skeleton library-welcome-sample-text">{" "}</span>
          <br />
          <span className="skeleton library-welcome-sample-text is-short">{" "}</span>
        </p>
        <p className="recipe-card-meta">
          <span className="library-meta-item skeleton library-welcome-sample-text is-meta">
            {" "}
          </span>
        </p>
      </div>
    </div>
  </li>
);

/** Set once sample cards have been on screen: coming back to the Cookbook shows them at once. */
let samplesShown = false;

const DiscoverShelf: React.FC = () => {
  const [recipes, setRecipes] = useState<readonly FeaturedRecipe[] | null>(() =>
    samplesShown ? samples : null
  );
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (recipes) {
      samplesShown = true;
      return;
    }

    let active = true;
    let cancelShow: () => void = () => undefined;

    loadWelcomeSamples().then(
      (loaded) => {
        // Even when the samples are already here (requested at boot), the cards follow the frame
        // that first shows the welcome, which stays as light as it can be.
        if (active) {
          cancelShow = afterNextPaint(() => {
            setRecipes(loaded);
          });
        }
      },
      () => {
        if (active) {
          setFailed(true);
        }
      }
    );

    return () => {
      active = false;
      cancelShow();
    };
  }, [recipes]);

  // Offline on a first visit: the shelf is extra, so it simply isn't there.
  if (failed || recipes?.length === 0) {
    return null;
  }

  return (
    <LibraryShelf
      className="library-welcome-discover"
      icon="book-open"
      subtitle="Real recipes, already cleaned up. Open one to see how LinkDish reads."
      title="Try a sample"
    >
      {recipes
        ? recipes.map((featured) => (
            <li key={featured.slug}>
              <RecipeCard
                className="library-shelf-card"
                imageSizes={LIBRARY_SHELF_CARD_SIZES}
                image={featured.recipe.image}
                mediaBadges={
                  <Badge className="library-media-badge" icon="sparkles" tone="butter">
                    Sample
                  </Badge>
                }
                meta={<CompactRecipeMeta recipe={featured.recipe} />}
                title={featured.recipe.title}
                to={`/featured/${featured.slug}`}
              />
            </li>
          ))
        : Array.from({ length: PLACEHOLDER_CARDS }, (_, index) => (
            <SamplePlaceholder key={index} />
          ))}
    </LibraryShelf>
  );
};

interface LibraryWelcomeProps {
  /** "empty": nothing saved at all. "starter": only the starter recipes so far. */
  variant: "empty" | "starter";
}

/**
 * The first thing a new cook sees: a paste-a-link field, how it works in three steps, and a shelf
 * of sample recipes to try.
 */
export const LibraryWelcome: React.FC<LibraryWelcomeProps> = ({ variant }) => (
  <div className={`library-welcome library-welcome-${variant}`}>
    <section aria-labelledby="library-welcome-title" className="library-welcome-hero">
      <div className="library-welcome-copy">
        <p className="library-welcome-eyebrow">
          {variant === "empty" ? "Your cookbook is ready" : "Welcome to LinkDish"}
        </p>
        <h2 className="library-welcome-title" id="library-welcome-title">
          Paste a link. <em className="library-welcome-accent">Get cooking.</em>
        </h2>
        <div aria-hidden="true" className="library-welcome-art">
          <Illustration name="cookbook" />
        </div>
        <p className="library-welcome-body">
          Save a recipe from anywhere and LinkDish turns it into a clean, cookable card with the
          photo and source kept.
        </p>
      </div>
      <PasteLinkForm />
      <ol aria-label="How it works" className="library-welcome-steps">
        {HOW_IT_WORKS.map((step, index) => (
          <li className="library-welcome-step" key={step.title}>
            <span aria-hidden="true" className="library-welcome-step-icon">
              <Icon name={step.icon} size={18} />
              <span className="library-welcome-step-number num">{index + 1}</span>
            </span>
            <span className="library-welcome-step-copy">
              <span className="library-welcome-step-title">{step.title}</span>
              <span className="library-welcome-step-body">{step.body}</span>
            </span>
          </li>
        ))}
      </ol>
    </section>
    <DiscoverShelf />
  </div>
);
