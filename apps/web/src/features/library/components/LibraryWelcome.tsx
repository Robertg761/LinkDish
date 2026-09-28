import React, { useEffect, useState } from "react";

import { Badge } from "../../../components/Badge";
import { Icon } from "../../../components/Icon";
import { Illustration } from "../../../components/illustrations";
import { RecipeCard } from "../../../components/RecipeCard";

import { LibraryShelf } from "./LibraryShelf";
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

/** The sample recipes load only here, so the Cookbook's own bundle stays small. */
const DiscoverShelf: React.FC = () => {
  const [recipes, setRecipes] = useState<FeaturedRecipe[] | null>(null);

  useEffect(() => {
    let active = true;

    import("../../featured/featured-recipes")
      .then((module) => {
        if (active) {
          setRecipes(module.featuredRecipes);
        }
      })
      .catch(() => {
        // Samples are a nice-to-have; the rest of the welcome still works offline.
      });

    return () => {
      active = false;
    };
  }, []);

  if (!recipes?.length) {
    return null;
  }

  return (
    <LibraryShelf
      className="library-welcome-discover"
      icon="book-open"
      subtitle="Real recipes, already cleaned up. Open one to see how LinkDish reads."
      title="Try a sample"
    >
      {recipes.map((featured) => (
        <li key={featured.slug}>
          <RecipeCard
            className="library-shelf-card"
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
