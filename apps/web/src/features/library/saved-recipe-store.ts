import { createStarterRecipeSeedRecords } from "@linkdish/recipe-domain";

import { apiClient } from "../../api/client";
import { getLinkDishWebDb, SAVED_RECIPES_STORE_NAME } from "../../storage/linkdish-db";

import type { WebSavedRecipe } from "./saved-recipe-types";
import type {
  ExtractRecipeImage,
  FetchMode,
  ExtractionProvenance,
  ExtractionStrategy,
  SharedRecipe
} from "@linkdish/api-contracts";
import type { Recipe } from "@linkdish/recipe-domain";

const STORE_NAME = SAVED_RECIPES_STORE_NAME;
const STARTER_RECIPES_SEEDED_STORAGE_KEY = "linkdish:web:starter-recipes-seeded:v1";

export const LOCAL_LIMIT_FREE = 15;

export const getDb = getLinkDishWebDb;

export async function generateDeterministicId(
  sourceUrl: string,
  recipeName: string
): Promise<string> {
  try {
    const data = new TextEncoder().encode(sourceUrl + recipeName);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return crypto.randomUUID();
  }
}

export async function getSavedRecipes(): Promise<WebSavedRecipe[]> {
  const db = await getDb();
  const tx = db.transaction(STORE_NAME, "readonly");
  const store = tx.objectStore(STORE_NAME);
  const recipes = (await store.getAll()) as WebSavedRecipe[];
  // Sort by updatedAt descending (newest first)
  return recipes.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

const getSourceHost = (sourceUrl: string): string => {
  try {
    return new URL(sourceUrl).hostname.replace(/^www\./i, "");
  } catch {
    return "unknown";
  }
};

export async function seedStarterRecipesIfNeeded(): Promise<void> {
  if (typeof localStorage === "undefined") {
    return;
  }

  const hasSeededStarterRecipes =
    localStorage.getItem(STARTER_RECIPES_SEEDED_STORAGE_KEY) === "true";
  if (hasSeededStarterRecipes) {
    return;
  }

  const existingRecipes = await getSavedRecipes();
  localStorage.setItem(STARTER_RECIPES_SEEDED_STORAGE_KEY, "true");

  if (existingRecipes.length > 0) {
    return;
  }

  const db = await getDb();
  const starterRecipes = createStarterRecipeSeedRecords();
  const tx = db.transaction(STORE_NAME, "readwrite");
  const store = tx.objectStore(STORE_NAME);

  for (const starterRecipe of starterRecipes) {
    const savedRecipe: WebSavedRecipe = {
      id: starterRecipe.id,
      recipe: starterRecipe.recipe,
      sourceUrl: starterRecipe.recipe.sourceUrl,
      sourceHost: getSourceHost(starterRecipe.recipe.sourceUrl),
      createdAt: starterRecipe.savedAt,
      updatedAt: starterRecipe.savedAt,
      extraction: {
        fetchMode: starterRecipe.fetchMode,
        provenance: starterRecipe.provenance,
        strategy: starterRecipe.strategy,
        warnings: starterRecipe.warnings
      },
      isStarter: true,
      timesCooked: 0,
      sync: {
        status: "local_only"
      }
    };

    await store.put(savedRecipe);
  }
}

export async function getSavedRecipeById(id: string): Promise<WebSavedRecipe | undefined> {
  const db = await getDb();
  return (await db.get(STORE_NAME, id)) as WebSavedRecipe | undefined;
}

export async function countSavedRecipes(): Promise<number> {
  const db = await getDb();
  return db.count(STORE_NAME);
}

export async function countQuotaSavedRecipes(): Promise<number> {
  const savedRecipes = await getSavedRecipes();
  return savedRecipes.filter((recipe) => !recipe.isStarter).length;
}

export interface SaveRecipeInput {
  recipe: Recipe;
  sourceUrl: string;
  sourceImages?: ExtractRecipeImage[] | undefined;
  extraction: {
    fetchMode: FetchMode;
    provenance: ExtractionProvenance[];
    strategy: ExtractionStrategy;
    warnings: string[];
  };
}

export async function saveRecipe(
  input: SaveRecipeInput,
  isPremiumUser: boolean
): Promise<{
  success: boolean;
  recipe?: WebSavedRecipe;
  error?: "limit_exceeded" | "duplicate_prompt";
}> {
  const db = await getDb();
  const id = await generateDeterministicId(input.sourceUrl, input.recipe.title);

  // Check if same ID already exists
  const existing = (await db.get(STORE_NAME, id)) as WebSavedRecipe | undefined;
  if (existing) {
    // Return explicit indicator to let user know they can replace it
    return { success: false, error: "duplicate_prompt" };
  }

  // Check limit if not premium
  if (!isPremiumUser) {
    const count = await countQuotaSavedRecipes();
    if (count >= LOCAL_LIMIT_FREE) {
      return { success: false, error: "limit_exceeded" };
    }
  }

  const sourceHost = getSourceHost(input.sourceUrl);

  const now = new Date().toISOString();
  const savedRecipe: WebSavedRecipe = {
    id,
    recipe: input.recipe,
    sourceUrl: input.sourceUrl,
    sourceHost,
    createdAt: now,
    updatedAt: now,
    extraction: input.extraction,
    sourceImages: input.sourceImages,
    timesCooked: 0,
    sync: {
      status: "local_only"
    }
  };

  await db.put(STORE_NAME, savedRecipe);
  return { success: true, recipe: savedRecipe };
}

export async function forceSaveRecipe(input: SaveRecipeInput): Promise<WebSavedRecipe> {
  const db = await getDb();
  const id = await generateDeterministicId(input.sourceUrl, input.recipe.title);

  const sourceHost = getSourceHost(input.sourceUrl);

  const existing = (await db.get(STORE_NAME, id)) as WebSavedRecipe | undefined;
  const existingSync = existing?.sync;
  const now = new Date().toISOString();
  const savedRecipe: WebSavedRecipe = {
    id,
    recipe: input.recipe,
    sourceUrl: input.sourceUrl,
    sourceHost,
    createdAt: existing ? existing.createdAt : now,
    updatedAt: now,
    extraction: input.extraction,
    sourceImages: input.sourceImages ?? existing?.sourceImages,
    timesCooked: existing?.timesCooked ?? 0,
    sync: existingSync?.sharedRecipeId
      ? {
          ...existingSync,
          status: "dirty"
        }
      : (existingSync ?? { status: "local_only" })
  };

  await db.put(STORE_NAME, savedRecipe);
  return savedRecipe;
}

export async function putSavedRecipe(recipe: WebSavedRecipe): Promise<WebSavedRecipe> {
  const db = await getDb();
  await db.put(STORE_NAME, recipe);
  return recipe;
}

export async function updateSavedRecipe(
  id: string,
  update: {
    notes?: string | undefined;
    recipe: Recipe;
  }
): Promise<WebSavedRecipe | undefined> {
  const existing = await getSavedRecipeById(id);

  if (!existing) {
    return undefined;
  }

  const updatedRecipe: WebSavedRecipe = {
    ...existing,
    notes: update.notes?.trim() || undefined,
    recipe: update.recipe,
    updatedAt: new Date().toISOString(),
    sync: {
      ...(existing.sync || { status: "local_only" }),
      status: existing.sync?.sharedRecipeId ? "dirty" : (existing.sync?.status ?? "local_only")
    }
  };

  return putSavedRecipe(updatedRecipe);
}

export async function duplicateSavedRecipe(id: string): Promise<WebSavedRecipe | undefined> {
  const existing = await getSavedRecipeById(id);

  if (!existing) {
    return undefined;
  }

  const now = new Date().toISOString();
  const duplicate: WebSavedRecipe = {
    ...existing,
    id: crypto.randomUUID(),
    createdAt: now,
    updatedAt: now,
    timesCooked: 0,
    sync: {
      status: "local_only"
    }
  };

  return putSavedRecipe(duplicate);
}

export function sharedRecipeToWebSavedRecipe(sharedRecipe: SharedRecipe): WebSavedRecipe {
  return {
    id: sharedRecipe.sourceSavedRecipeId ?? `shared-${sharedRecipe.id}`,
    createdAt: sharedRecipe.createdAt,
    extraction: {
      fetchMode: sharedRecipe.fetchMode,
      provenance: sharedRecipe.provenance,
      strategy: sharedRecipe.strategy,
      warnings: sharedRecipe.warnings
    },
    notes: sharedRecipe.notes,
    recipe: sharedRecipe.recipe,
    sourceHost: getSharedRecipeSourceHost(sharedRecipe),
    sourceUrl: sharedRecipe.recipe.sourceUrl,
    timesCooked: 0,
    sync: {
      lastSyncedAt: sharedRecipe.updatedAt,
      sharedRecipeId: sharedRecipe.id,
      status: "synced"
    },
    updatedAt: sharedRecipe.updatedAt
  };
}

export function getSharedRecipeSourceHost(sharedRecipe: SharedRecipe): string {
  try {
    return new URL(sharedRecipe.recipe.sourceUrl).hostname.replace(/^www\./i, "");
  } catch {
    return "unknown";
  }
}

export function getSharedRecipeOwnerLabel(
  sharedRecipe: Pick<SharedRecipe, "ownerAvatarEmoji" | "ownerDisplayName" | "ownerEmail">
): string {
  const ownerName = sharedRecipe.ownerDisplayName?.trim() || sharedRecipe.ownerEmail;
  return sharedRecipe.ownerAvatarEmoji
    ? `${sharedRecipe.ownerAvatarEmoji} ${ownerName}`
    : ownerName;
}

function getCopyTitle(recipes: WebSavedRecipe[], title: string): string {
  const titles = new Set(recipes.map((entry) => entry.recipe.title.trim().toLowerCase()));
  let candidate = `${title} Copy`;
  let index = 2;

  while (titles.has(candidate.toLowerCase())) {
    candidate = `${title} Copy ${index}`;
    index += 1;
  }

  return candidate;
}

export async function saveSharedRecipeCopy(sharedRecipe: SharedRecipe): Promise<WebSavedRecipe> {
  const db = await getDb();
  const existingRecipes = await getSavedRecipes();
  const now = new Date().toISOString();
  const savedRecipe: WebSavedRecipe = {
    id: crypto.randomUUID(),
    createdAt: now,
    extraction: {
      fetchMode: sharedRecipe.fetchMode,
      provenance: sharedRecipe.provenance,
      strategy: sharedRecipe.strategy,
      warnings: sharedRecipe.warnings
    },
    notes: sharedRecipe.notes,
    recipe: {
      ...sharedRecipe.recipe,
      ingredients: sharedRecipe.recipe.ingredients.map((ingredient) => ({ ...ingredient })),
      steps: sharedRecipe.recipe.steps.map((step) => ({ ...step })),
      title: getCopyTitle(existingRecipes, sharedRecipe.recipe.title)
    },
    sourceHost: getSharedRecipeSourceHost(sharedRecipe),
    sourceUrl: sharedRecipe.recipe.sourceUrl,
    timesCooked: 0,
    sync: {
      status: "local_only"
    },
    updatedAt: now
  };

  await db.put(STORE_NAME, savedRecipe);
  return savedRecipe;
}

export async function syncRecipeToHousehold(recipe: WebSavedRecipe): Promise<WebSavedRecipe> {
  if (recipe.isStarter) {
    return putSavedRecipe({
      ...recipe,
      sync: {
        status: "local_only"
      }
    });
  }

  try {
    const household = await apiClient.getHousehold();

    if (!household.household) {
      const nextRecipe: WebSavedRecipe = {
        ...recipe,
        sync: {
          ...(recipe.sync || { status: "local_only" }),
          status: "local_only"
        }
      };
      return putSavedRecipe(nextRecipe);
    }

    const sharedRecipeId = recipe.sync?.sharedRecipeId;
    const payload = {
      fetchMode: recipe.extraction.fetchMode,
      notes: recipe.notes ?? null,
      provenance: recipe.extraction.provenance,
      recipe: recipe.recipe,
      strategy: recipe.extraction.strategy,
      warnings: recipe.extraction.warnings
    };

    const response = sharedRecipeId
      ? await apiClient.updateSharedRecipe(sharedRecipeId, payload)
      : await apiClient.createSharedRecipe({
          ...payload,
          sourceSavedRecipeId: recipe.id
        });
    const nextRecipe: WebSavedRecipe = {
      ...recipe,
      sync: {
        lastSyncedAt: response.recipe.updatedAt,
        sharedRecipeId: response.recipe.id,
        status: "synced"
      }
    };

    return putSavedRecipe(nextRecipe);
  } catch (error) {
    const nextRecipe: WebSavedRecipe = {
      ...recipe,
      sync: {
        ...(recipe.sync || { status: "local_only" }),
        lastError: error instanceof Error ? error.message : "Sync error",
        status: "sync_failed"
      }
    };

    return putSavedRecipe(nextRecipe);
  }
}

export async function deleteSavedRecipe(id: string): Promise<void> {
  const db = await getDb();
  await db.delete(STORE_NAME, id);
}

export async function incrementSavedRecipeTimesCooked(
  id: string
): Promise<WebSavedRecipe | undefined> {
  const existing = await getSavedRecipeById(id);

  if (!existing) {
    return undefined;
  }

  const updatedRecipe: WebSavedRecipe = {
    ...existing,
    timesCooked: (existing.timesCooked ?? 0) + 1
  };

  return putSavedRecipe(updatedRecipe);
}

export async function updateSavedRecipeSync(
  id: string,
  syncData: Partial<NonNullable<WebSavedRecipe["sync"]>>
): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(STORE_NAME, "readwrite");
  const store = tx.objectStore(STORE_NAME);
  const existing = (await store.get(id)) as WebSavedRecipe | undefined;
  if (existing) {
    existing.sync = {
      ...(existing.sync || { status: "local_only" }),
      ...syncData
    };
    await store.put(existing);
  }
}
