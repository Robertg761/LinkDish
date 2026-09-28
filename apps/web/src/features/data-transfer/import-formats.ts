/** Import formats LinkDish understands. Dependency-free so the Settings page can render the picker. */

export type ImportSource = "linkdish" | "paprika" | "mela" | "schema_org";

export const IMPORT_SOURCE_LABELS: Record<ImportSource, string> = {
  linkdish: "LinkDish backup",
  mela: "Mela",
  paprika: "Paprika",
  schema_org: "Recipe file"
};

/** File picker filter: LinkDish backups and schema.org (.json), Paprika and Mela exports. */
export const IMPORT_FILE_ACCEPT =
  ".json,.paprikarecipes,.paprikarecipe,.melarecipes,.melarecipe,application/json,application/zip";

/** The largest file we try to open (Paprika exports with photos can be big). */
export const MAX_IMPORT_FILE_BYTES = 300 * 1024 * 1024;
