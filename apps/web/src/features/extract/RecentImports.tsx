import React, { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { Icon } from "../../components/Icon";
import { RecipeCard } from "../../components/RecipeCard";
import { useSavedRecipes } from "../../data/library-store";
import { getRecipeSourceInfo } from "../recipe-view/recipe-source";

import type { FeaturedRecipe } from "../featured/types";
import type { WebSavedRecipe } from "../library/saved-recipe-types";

const RECENT_COUNT = 4;

const timeOf = (value: string): number => {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : 0;
};

const relativeDay = (iso: string, now: number): string => {
  const days = Math.floor((now - timeOf(iso)) / 86_400_000);

  if (days <= 0) {
    return "Today";
  }

  if (days === 1) {
    return "Yesterday";
  }

  if (days < 7) {
    return `${days} days ago`;
  }

  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
};

const sourceLabelFor = (recipe: WebSavedRecipe): string =>
  recipe.sourceUrl.includes("linkdish.app/text-imports/")
    ? "From your text"
    : getRecipeSourceInfo(recipe.sourceUrl, { sourceHost: recipe.sourceHost }).label;

/** Samples for a brand-new cookbook: loaded on demand, like the Cookbook's welcome shelf. */
const SampleRecipes: React.FC = () => {
  const [samples, setSamples] = useState<FeaturedRecipe[] | null>(null);

  useEffect(() => {
    let active = true;
    import("../featured/featured-recipes").then(
      (module) => {
        if (active) {
          setSamples(module.featuredRecipes.slice(0, 3));
        }
      },
      () => undefined
    );

    return () => {
      active = false;
    };
  }, []);

  if (!samples?.length) {
    return null;
  }

  return (
    <section aria-labelledby="import-samples-title" className="import-recent">
      <div className="import-recent-head">
        <h2 className="import-recent-title" id="import-samples-title">
          Try a sample
        </h2>
      </div>
      <p className="import-recent-intro">
        See what LinkDish does with a real recipe before you paste your own.
      </p>
      <ul className="import-recent-list">
        {samples.map((sample) => (
          <li key={sample.slug}>
            <RecipeCard
              image={sample.recipe.image}
              meta={getRecipeSourceInfo(sample.sourceUrl).label}
              title={sample.recipe.title}
              to={`/featured/${sample.slug}`}
              variant="list"
            />
          </li>
        ))}
      </ul>
    </section>
  );
};

/** The last few recipes that came in through the importer, or samples for a new cookbook. */
export const RecentImports: React.FC = () => {
  const { recipes, status } = useSavedRecipes();
  const [now] = useState(() => Date.now());
  const recent = useMemo(
    () =>
      recipes
        .filter((recipe) => !recipe.isStarter)
        .sort((left, right) => timeOf(right.createdAt) - timeOf(left.createdAt))
        .slice(0, RECENT_COUNT),
    [recipes]
  );

  if (status === "loading") {
    return null;
  }

  if (recent.length === 0) {
    return <SampleRecipes />;
  }

  return (
    <section aria-labelledby="import-recent-title" className="import-recent">
      <div className="import-recent-head">
        <h2 className="import-recent-title" id="import-recent-title">
          Recently saved
        </h2>
        <Link className="import-recent-link" to="/">
          Cookbook <Icon name="chevron-right" size={16} />
        </Link>
      </div>
      <ul className="import-recent-list">
        {recent.map((recipe) => (
          <li key={recipe.id}>
            <RecipeCard
              image={recipe.recipe.image}
              meta={`${sourceLabelFor(recipe)} · ${relativeDay(recipe.createdAt, now)}`}
              title={recipe.recipe.title}
              to={`/recipes/${recipe.id}`}
              variant="list"
            />
          </li>
        ))}
      </ul>
    </section>
  );
};
