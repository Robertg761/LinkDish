import type { FetchMode, ExtractionProvenance, ExtractionStrategy } from "@linkdish/api-contracts";
import type { Recipe } from "@linkdish/recipe-domain";

export interface FeaturedRecipe {
  slug: string;
  sourceUrl: string;
  recipe: Recipe;
  extraction: {
    fetchMode: FetchMode;
    provenance: ExtractionProvenance[];
    strategy: ExtractionStrategy;
    warnings: string[];
  };
}
