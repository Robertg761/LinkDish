/**
 * Turns a chosen file into import candidates: a LinkDish backup (.json), a Paprika export
 * (.paprikarecipes — a ZIP of gzip-compressed JSON recipes — or a single .paprikarecipe), a Mela
 * export (.melarecipes — a ZIP of JSON recipes — or a single .melarecipe) or schema.org JSON-LD.
 * The format is recognized from the content, not the file name. Mapping is done by the
 * @linkdish/recipe-domain importers; this module only unpacks containers and gathers results.
 * Everything runs in the browser — nothing is uploaded.
 */
import {
  findSchemaOrgRecipe,
  melaRecipeToRecipe,
  paprikaRecipeToRecipe,
  schemaOrgRecipeToRecipe,
  validateBackup
} from "@linkdish/recipe-domain";

import { readWebBackupExtras } from "./backup-format";
import { DataTransferError } from "./errors";
import { MAX_IMPORT_FILE_BYTES } from "./import-formats";
import {
  gunzip,
  isGzipData,
  isJunkZipEntry,
  isZipData,
  listZipEntries,
  readZipEntry
} from "./zip-reader";

import type { WebBackupExtras } from "./backup-format";
import type { ImportSource } from "./import-formats";
import type { RecipeCookLogEntry, RecipeRating } from "../library/saved-recipe-types";
import type { ExtractRecipeImage } from "@linkdish/api-contracts";
import type {
  BackupCollection,
  MealPlanEntry as BackupMealPlanEntry,
  Recipe,
  RecipeImportResult
} from "@linkdish/recipe-domain";

export type { ImportSource } from "./import-formats";

/** Warnings kept for the preview; the rest are summarized as a count. */
const MAX_WARNINGS = 40;
/** Decompressed bytes allowed across a whole archive (zip-bomb guard). */
const MAX_TOTAL_UNPACKED_BYTES = 1024 * 1024 * 1024;

export interface ImportCandidate {
  /** Position in the file (stable order). */
  index: number;
  recipe: Recipe;
  sourceUrl: string;
  /** True when the export had no web address and a linkdish.app/imports URL was made up. */
  sourceUrlSynthetic: boolean;
  /** The saved-recipe id from a LinkDish backup. */
  originalId?: string | undefined;
  favorite?: boolean | undefined;
  tags?: string[] | undefined;
  rating?: RecipeRating | undefined;
  notes?: string | undefined;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
  timesCooked?: number | undefined;
  cookLog?: RecipeCookLogEntry[] | undefined;
  lastCookedAt?: string | undefined;
  lastOpenedAt?: string | undefined;
  preferredServings?: number | undefined;
  extraction?: WebBackupExtras["recipes"][string]["extraction"];
  sourceImages?: ExtractRecipeImage[] | undefined;
}

export interface ParsedCollection extends BackupCollection {
  emoji?: string | undefined;
  description?: string | undefined;
  sortOrder?: number | undefined;
}

export interface ParsedMealPlanEntry extends BackupMealPlanEntry {
  createdAt?: string | undefined;
}

export interface ParsedImportFile {
  source: ImportSource;
  fileName: string;
  candidates: ImportCandidate[];
  /** Recipes in the file that couldn't be imported (missing steps, damaged, …). */
  unreadable: number;
  /** Plain-language notes for the preview, most important first. */
  warnings: string[];
  /** Photos embedded in the export that were left out (LinkDish keeps photos as web links). */
  photosSkipped: number;
  /** LinkDish backups only. */
  collections: ParsedCollection[];
  mealPlan: ParsedMealPlanEntry[];
  exportedAt?: string | undefined;
  /** How many recipes in a backup carry their original scans. */
  scannedPhotoRecipes: number;
}

export interface ImportProgress {
  done: number;
  total: number;
}

export interface ParseImportOptions {
  onProgress?: ((progress: ImportProgress) => void) | undefined;
  signal?: AbortSignal | undefined;
}

type RecipeFormat = ImportSource;

const utf8 = new TextDecoder("utf-8");
/** "The recipe has no steps, so it can't be imported." → "steps" */
const MISSING_PART_PATTERN = /^The recipe has no (\w+), so it can't be imported\.$/u;

const recordOf = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Which exporter a single parsed JSON object came from, or null when it isn't a recipe. */
export const classifyRecipeJson = (value: unknown): RecipeFormat | null => {
  const record = recordOf(value);

  if (record.format === "linkdish-backup") {
    return "linkdish";
  }

  if ("@type" in record || "@graph" in record || "@context" in record) {
    return findSchemaOrgRecipe(value) ? "schema_org" : null;
  }

  if (
    typeof record.name === "string" &&
    ("directions" in record || "uid" in record || "on_favorites" in record)
  ) {
    return "paprika";
  }

  if (
    typeof record.title === "string" &&
    ("instructions" in record || "wantToCook" in record || "link" in record)
  ) {
    return "mela";
  }

  return null;
};

const throwIfAborted = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted) {
    throw new DOMException("The import was cancelled.", "AbortError");
  }
};

const parseJsonBytes = (bytes: Uint8Array): unknown => {
  let text = utf8.decode(bytes);

  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }

  return JSON.parse(text) as unknown;
};

const isRating = (value: unknown): value is RecipeRating =>
  value === 1 || value === 2 || value === 3 || value === 4 || value === 5;

class CandidateCollector {
  public readonly candidates: ImportCandidate[] = [];
  public readonly warnings: string[] = [];
  public unreadable = 0;
  public photosSkipped = 0;
  private hiddenWarnings = 0;

  public warn(message: string): void {
    if (this.warnings.length < MAX_WARNINGS) {
      this.warnings.push(message);
    } else {
      this.hiddenWarnings += 1;
    }
  }

  public finishWarnings(): string[] {
    return this.hiddenWarnings > 0
      ? [...this.warnings, `…and ${this.hiddenWarnings} more notes.`]
      : this.warnings;
  }

  /** Strips embedded photos before mapping (LinkDish stores photos as web links only). */
  public stripPhotos(format: RecipeFormat, json: Record<string, unknown>): Record<string, unknown> {
    if (format === "paprika") {
      const hasPhoto =
        (typeof json.photo_data === "string" && json.photo_data.length > 0) ||
        (Array.isArray(json.photos) && json.photos.length > 0);
      if (hasPhoto) {
        this.photosSkipped += 1;
      }
      const rest = { ...json };
      delete rest.photo_data;
      delete rest.photos;
      return rest;
    }

    if (format === "mela") {
      if (Array.isArray(json.images) && json.images.length > 0) {
        this.photosSkipped += 1;
      }
      const rest = { ...json };
      delete rest.images;
      return rest;
    }

    return json;
  }

  public addMapped(result: RecipeImportResult, fallbackName: string): void {
    const title = result.recipe?.title || fallbackName;

    if (!result.recipe) {
      this.unreadable += 1;
      const missing = result.warnings
        .map((warning) => MISSING_PART_PATTERN.exec(warning)?.[1])
        .find(Boolean);
      this.warn(
        missing
          ? `“${title}” was skipped because it has no ${missing}.`
          : `“${title}” couldn't be read, so it was skipped.`
      );
      return;
    }

    for (const warning of result.warnings) {
      if (!warning.startsWith("The photo")) {
        this.warn(`“${title}”: ${warning}`);
      }
    }

    const { meta } = result;
    const tags = meta.tags?.filter((tag) => tag.trim().length > 0);
    const notes = meta.notes?.trim();

    this.candidates.push({
      index: this.candidates.length,
      recipe: result.recipe,
      sourceUrl: meta.sourceUrl,
      sourceUrlSynthetic: meta.sourceUrlSynthetic,
      ...(meta.favorite ? { favorite: true } : {}),
      ...(tags && tags.length > 0 ? { tags } : {}),
      ...(isRating(meta.rating) ? { rating: meta.rating } : {}),
      ...(notes ? { notes } : {}),
      ...(meta.createdAt ? { createdAt: meta.createdAt } : {})
    });
  }
}

const mapRecipeJson = (
  format: RecipeFormat,
  json: unknown,
  collector: CandidateCollector,
  fallbackName: string
): void => {
  if (format === "schema_org") {
    collector.addMapped(schemaOrgRecipeToRecipe(json), fallbackName);
    return;
  }

  const stripped = collector.stripPhotos(format, recordOf(json));

  if (format === "paprika") {
    collector.addMapped(paprikaRecipeToRecipe(stripped), fallbackName);
  } else if (format === "mela") {
    collector.addMapped(melaRecipeToRecipe(stripped), fallbackName);
  }
};

/** Every schema.org Recipe node in a JSON-LD document (arrays and @graph included). */
const schemaOrgRecipeNodes = (value: unknown): unknown[] => {
  const roots = Array.isArray(value) ? value : [value];
  const nodes: unknown[] = [];

  for (const root of roots) {
    const graph = recordOf(root)["@graph"];
    const candidates = Array.isArray(graph) ? graph : [root];

    for (const candidate of candidates) {
      const recipe = findSchemaOrgRecipe(candidate);

      if (recipe && !nodes.includes(recipe)) {
        nodes.push(recipe);
      }
    }
  }

  return nodes;
};

const baseName = (name: string): string =>
  (name.split("/").pop() ?? name).replace(/\.(paprikarecipe|melarecipe|json)$/iu, "");

const toParsedFile = (source: ImportSource, fileName: string, collector: CandidateCollector) => ({
  source,
  fileName,
  candidates: collector.candidates,
  unreadable: collector.unreadable,
  warnings: collector.finishWarnings(),
  photosSkipped: collector.photosSkipped,
  collections: [] as ParsedCollection[],
  mealPlan: [] as ParsedMealPlanEntry[],
  scannedPhotoRecipes: 0
});

const simplifyBackupWarning = (warning: string): string => {
  const match = /^(.*? was skipped):/u.exec(warning);
  return match ? `${match[1]} because part of it was damaged.` : warning;
};

const parseLinkDishBackup = (json: unknown, fileName: string): ParsedImportFile => {
  const result = validateBackup(json);

  if (!result.ok) {
    if (result.error.includes("newer version")) {
      throw new DataTransferError("newer_backup");
    }

    throw new DataTransferError(
      "corrupt_file",
      "This backup file is damaged, so it can't be restored. Try downloading a fresh backup."
    );
  }

  const { backup } = result;
  const { extras, skipped } = readWebBackupExtras(json);
  const collector = new CandidateCollector();

  for (const warning of result.warnings) {
    collector.warn(simplifyBackupWarning(warning));
  }

  if (skipped > 0) {
    collector.warn(
      `${skipped} extra detail${skipped === 1 ? " was" : "s were"} damaged and left out.`
    );
  }

  let scannedPhotoRecipes = 0;

  backup.recipes.forEach((entry) => {
    const { meta } = entry;
    const recipeExtras = entry.id ? extras.recipes[entry.id] : undefined;
    const sourceImages = entry.id ? extras.sourceImages?.[entry.id] : undefined;
    const notes = meta.notes?.trim();
    const cookLog = meta.cookLog?.map(
      (log): RecipeCookLogEntry => ({
        cookedAt: log.cookedAt,
        ...(log.note?.trim() ? { note: log.note.trim() } : {})
      })
    );

    if (sourceImages?.length) {
      scannedPhotoRecipes += 1;
    }

    collector.candidates.push({
      index: collector.candidates.length,
      recipe: entry.recipe,
      sourceUrl: meta.sourceUrl,
      sourceUrlSynthetic: false,
      ...(entry.id ? { originalId: entry.id } : {}),
      ...(meta.favorite ? { favorite: true } : {}),
      ...(meta.tags?.length ? { tags: meta.tags } : {}),
      ...(isRating(meta.rating) ? { rating: meta.rating } : {}),
      ...(notes ? { notes } : {}),
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      ...(meta.timesCooked !== undefined ? { timesCooked: meta.timesCooked } : {}),
      ...(cookLog?.length ? { cookLog } : {}),
      ...(recipeExtras?.lastCookedAt ? { lastCookedAt: recipeExtras.lastCookedAt } : {}),
      ...(recipeExtras?.lastOpenedAt ? { lastOpenedAt: recipeExtras.lastOpenedAt } : {}),
      ...(recipeExtras?.preferredServings
        ? { preferredServings: recipeExtras.preferredServings }
        : {}),
      ...(recipeExtras?.extraction ? { extraction: recipeExtras.extraction } : {}),
      ...(sourceImages?.length ? { sourceImages } : {})
    });
  });

  const skippedRecipes = result.warnings.filter((warning) => warning.startsWith("Recipe ")).length;

  return {
    source: "linkdish",
    fileName,
    candidates: collector.candidates,
    unreadable: skippedRecipes,
    warnings: collector.finishWarnings(),
    photosSkipped: 0,
    collections: (backup.collections ?? []).map((collection) => {
      const collectionExtras = extras.collections[collection.id];
      return {
        ...collection,
        ...(collectionExtras?.emoji ? { emoji: collectionExtras.emoji } : {}),
        ...(collectionExtras?.description ? { description: collectionExtras.description } : {}),
        ...(collectionExtras?.sortOrder !== undefined
          ? { sortOrder: collectionExtras.sortOrder }
          : {})
      };
    }),
    mealPlan: (backup.mealPlan ?? []).map((entry) => {
      const createdAt = extras.mealPlan[entry.id]?.createdAt;
      return createdAt ? { ...entry, createdAt } : entry;
    }),
    exportedAt: backup.exportedAt,
    scannedPhotoRecipes
  };
};

const parseJsonDocument = (json: unknown, fileName: string): ParsedImportFile => {
  const format = classifyRecipeJson(json);

  if (format === "linkdish") {
    return parseLinkDishBackup(json, fileName);
  }

  const collector = new CandidateCollector();

  if (format === "schema_org" || (Array.isArray(json) && schemaOrgRecipeNodes(json).length > 0)) {
    for (const node of schemaOrgRecipeNodes(json)) {
      mapRecipeJson("schema_org", node, collector, baseName(fileName));
    }

    return toParsedFile("schema_org", fileName, collector);
  }

  if (format === "paprika" || format === "mela") {
    mapRecipeJson(format, json, collector, baseName(fileName));
    return toParsedFile(format, fileName, collector);
  }

  // A JSON array of Paprika or Mela recipes (some tools export these).
  if (Array.isArray(json)) {
    const formats = json.map(classifyRecipeJson);
    const first = formats.find((entry) => entry === "paprika" || entry === "mela");

    if (first) {
      json.forEach((entry, index) => {
        const entryFormat = formats[index];

        if (entryFormat === "paprika" || entryFormat === "mela") {
          mapRecipeJson(entryFormat, entry, collector, `Recipe ${index + 1}`);
        } else {
          collector.unreadable += 1;
        }
      });

      return toParsedFile(first, fileName, collector);
    }
  }

  throw new DataTransferError("unsupported_file");
};

const parseZipArchive = async (
  bytes: Uint8Array,
  fileName: string,
  options: ParseImportOptions
): Promise<ParsedImportFile> => {
  const entries = listZipEntries(bytes).filter((entry) => !isJunkZipEntry(entry));

  if (entries.length === 0) {
    throw new DataTransferError("no_recipes");
  }

  if (entries.every((entry) => entry.encrypted)) {
    throw new DataTransferError("password_protected");
  }

  const collector = new CandidateCollector();
  const counts: Record<RecipeFormat, number> = {
    linkdish: 0,
    mela: 0,
    paprika: 0,
    schema_org: 0
  };
  let unpackedBytes = 0;
  let backup: ParsedImportFile | null = null;

  for (const [position, entry] of entries.entries()) {
    throwIfAborted(options.signal);
    options.onProgress?.({ done: position, total: entries.length });

    const name = baseName(entry.name);

    try {
      let data = await readZipEntry(bytes, entry);

      if (isGzipData(data)) {
        data = await gunzip(data);
      }

      unpackedBytes += data.length;

      if (unpackedBytes > MAX_TOTAL_UNPACKED_BYTES) {
        throw new DataTransferError("file_too_large");
      }

      const json = parseJsonBytes(data);
      const format = classifyRecipeJson(json);

      if (format === "linkdish" && !backup) {
        backup = parseLinkDishBackup(json, fileName);
        continue;
      }

      if (!format || format === "linkdish") {
        // Not a recipe (a README, an index file); ignore quietly.
        continue;
      }

      counts[format] += 1;

      if (format === "schema_org") {
        for (const node of schemaOrgRecipeNodes(json)) {
          mapRecipeJson(format, node, collector, name);
        }
      } else {
        mapRecipeJson(format, json, collector, name);
      }
    } catch (error) {
      if (
        error instanceof DataTransferError &&
        (error.code === "file_too_large" || error.code === "unsupported_browser")
      ) {
        throw error;
      }

      if (error instanceof DOMException && error.name === "AbortError") {
        throw error;
      }

      collector.unreadable += 1;
      collector.warn(`“${name}” couldn't be read, so it was skipped.`);
    }
  }

  options.onProgress?.({ done: entries.length, total: entries.length });

  if (backup && collector.candidates.length === 0) {
    return backup;
  }

  const source =
    (Object.entries(counts) as Array<[RecipeFormat, number]>)
      .filter(([, count]) => count > 0)
      .sort((left, right) => right[1] - left[1])[0]?.[0] ??
    (fileName.toLowerCase().includes("mela") ? "mela" : "paprika");

  return toParsedFile(source, fileName, collector);
};

/**
 * Reads an import file's bytes into candidates. Throws {@link DataTransferError} with a friendly
 * message for empty, unsupported, damaged or oversized files, or when nothing importable is found.
 */
export const parseImportFile = async (
  file: { name: string; bytes: Uint8Array },
  options: ParseImportOptions = {}
): Promise<ParsedImportFile> => {
  const { bytes, name } = file;

  if (bytes.length === 0) {
    throw new DataTransferError("empty_file");
  }

  // readFileBytes already turns oversized files away by size; this covers bytes from elsewhere.
  if (bytes.length > MAX_IMPORT_FILE_BYTES) {
    throw new DataTransferError("file_too_large");
  }

  let parsed: ParsedImportFile;

  if (isZipData(bytes)) {
    parsed = await parseZipArchive(bytes, name, options);
  } else if (isGzipData(bytes)) {
    // A single .paprikarecipe file is one gzip-compressed recipe.
    let json: unknown;

    try {
      json = parseJsonBytes(await gunzip(bytes));
    } catch (error) {
      if (error instanceof DataTransferError && error.code !== "corrupt_file") {
        throw error;
      }

      throw new DataTransferError("corrupt_file");
    }

    parsed = parseJsonDocument(json, name);
  } else {
    let json: unknown;

    try {
      json = parseJsonBytes(bytes);
    } catch {
      throw new DataTransferError(
        /\.(json|melarecipe)$/iu.test(name) ? "corrupt_file" : "unsupported_file"
      );
    }

    parsed = parseJsonDocument(json, name);
  }

  if (parsed.candidates.length === 0 && parsed.mealPlan.length === 0) {
    throw new DataTransferError(
      "no_recipes",
      parsed.unreadable > 0
        ? `We found ${parsed.unreadable} recipe${parsed.unreadable === 1 ? "" : "s"} in that file, but none had the ingredients and steps LinkDish needs.`
        : undefined
    );
  }

  return parsed;
};

/**
 * Reads a File's bytes (FileReader fallback for browsers without Blob.arrayBuffer). A file over
 * {@link MAX_IMPORT_FILE_BYTES} is turned away from its size alone, before anything is read:
 * holding a huge export in memory can freeze or crash the tab. {@link parseImportFile} checks the
 * byte count again, with the same error.
 */
export const readFileBytes = async (file: Blob): Promise<Uint8Array> => {
  if (file.size > MAX_IMPORT_FILE_BYTES) {
    throw new DataTransferError("file_too_large");
  }

  if (typeof file.arrayBuffer === "function") {
    return new Uint8Array(await file.arrayBuffer());
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      resolve(new Uint8Array(reader.result as ArrayBuffer));
    };
    reader.onerror = () => {
      reject(
        new DataTransferError("corrupt_file", "We couldn't open that file. Please try again.")
      );
    };
    reader.readAsArrayBuffer(file);
  });
};
