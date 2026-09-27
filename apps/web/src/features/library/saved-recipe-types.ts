import type {
  ExtractRecipeImage,
  FetchMode,
  ExtractionProvenance,
  ExtractionStrategy
} from "@linkdish/api-contracts";
import type { Recipe } from "@linkdish/recipe-domain";

export type RecipeRating = 1 | 2 | 3 | 4 | 5;

export interface RecipeCookLogEntry {
  cookedAt: string;
  note?: string | undefined;
}

export interface WebSavedRecipe {
  id: string;
  recipe: Recipe;
  sourceUrl: string;
  sourceHost: string;
  createdAt: string;
  updatedAt: string;
  extraction: {
    fetchMode: FetchMode;
    provenance: ExtractionProvenance[];
    strategy: ExtractionStrategy;
    warnings: string[];
  };
  isStarter?: boolean | undefined;
  notes?: string | undefined;
  /**
   * Original scans for image imports. Since IndexedDB v4 these live in the `recipeSourceImages`
   * store: list reads never carry them, `getSavedRecipeById` hydrates them for the detail page.
   */
  sourceImages?: ExtractRecipeImage[] | undefined;
  /** How many source images are stored separately for this recipe (set since IndexedDB v4). */
  sourceImageCount?: number | undefined;
  timesCooked?: number | undefined;
  sync?: {
    status: "local_only" | "synced" | "dirty" | "sync_failed";
    sharedRecipeId?: string;
    lastSyncedAt?: string;
    lastError?: string;
  };

  /* Local-only personal metadata. Never part of the household sync payload. */
  favorite?: boolean | undefined;
  tags?: string[] | undefined;
  collectionIds?: string[] | undefined;
  rating?: RecipeRating | undefined;
  cookLog?: RecipeCookLogEntry[] | undefined;
  lastCookedAt?: string | undefined;
  lastOpenedAt?: string | undefined;
  preferredServings?: number | undefined;
}

/** Keys of {@link WebSavedRecipe} that hold local-only personal metadata. */
export type WebSavedRecipeMetadataKey =
  | "favorite"
  | "tags"
  | "collectionIds"
  | "rating"
  | "cookLog"
  | "lastCookedAt"
  | "lastOpenedAt"
  | "preferredServings";

/** A record in the `recipeSourceImages` object store. */
export interface WebRecipeSourceImagesRecord {
  images: ExtractRecipeImage[];
  recipeId: string;
  updatedAt: string;
}
