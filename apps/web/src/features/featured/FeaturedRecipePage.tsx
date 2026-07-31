import React from "react";
import { useNavigate, useParams } from "react-router-dom";

import { ButtonLink } from "../../components/Button";
import { ErrorState } from "../../components/ErrorState";
import { ExtractResult } from "../extract/ExtractResult";

import { getFeaturedRecipeBySlug } from "./featured-recipes";

export const FeaturedRecipePage: React.FC = () => {
  const { slug } = useParams<{ slug?: string }>();
  const navigate = useNavigate();
  const featuredRecipe = getFeaturedRecipeBySlug(slug);

  if (!featuredRecipe) {
    return (
      <div className="container page-enter">
        <ErrorState
          title="Featured recipe not found"
          message="That featured LinkDish recipe is no longer available."
        />
        <div className="error-actions">
          <ButtonLink to="/import" variant="primary">
            Import a recipe
          </ButtonLink>
        </div>
      </div>
    );
  }

  return (
    <div className="page-enter">
      <ExtractResult
        extraction={featuredRecipe.extraction}
        onReset={() => navigate("/import")}
        recipe={featuredRecipe.recipe}
        sourceUrl={featuredRecipe.sourceUrl}
      />
    </div>
  );
};
