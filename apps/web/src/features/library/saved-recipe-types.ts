import type {
  ExtractRecipeImage,
  FetchMode,
  ExtractionProvenance,
  ExtractionStrategy
} from "@linkdish/api-contracts";
import type { Recipe } from "@linkdish/recipe-domain";

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
  sourceImages?: ExtractRecipeImage[] | undefined;
  timesCooked?: number | undefined;
  sync?: {
    status: "local_only" | "synced" | "dirty" | "sync_failed";
    sharedRecipeId?: string;
    lastSyncedAt?: string;
    lastError?: string;
  };
}
