/**
 * Errors from reading, restoring and exporting files. Every error carries a sentence written for
 * the person using LinkDish, so the UI can show `error.message` as-is; anything else that is
 * thrown goes through {@link getDataTransferErrorMessage}, which never shows raw exceptions.
 */

export type DataTransferErrorCode =
  | "empty_file"
  | "file_too_large"
  | "unsupported_file"
  | "corrupt_file"
  | "password_protected"
  | "newer_backup"
  | "no_recipes"
  | "unsupported_browser"
  | "storage_full"
  | "storage_unavailable"
  | "write_failed"
  | "export_failed"
  | "backup_too_large";

const DEFAULT_MESSAGES: Record<DataTransferErrorCode, string> = {
  empty_file: "That file is empty. Choose a LinkDish backup or a recipe export.",
  file_too_large:
    "That file is too big to open here. Try exporting fewer recipes at a time, or without photos.",
  unsupported_file:
    "LinkDish can't read that kind of file yet. Choose a LinkDish backup (.json), a Paprika export (.paprikarecipes) or a Mela export (.melarecipes or .melarecipe).",
  corrupt_file: "That file looks damaged, so we couldn't read it. Try exporting it again.",
  password_protected: "That file is password-protected. Export it again without a password.",
  newer_backup:
    "This backup was made by a newer version of LinkDish. Update the app to restore it.",
  no_recipes: "We couldn't find any recipes in that file.",
  unsupported_browser:
    "This browser can't open compressed recipe exports. Try the latest Chrome, Safari, Edge or Firefox.",
  storage_full:
    "Your device is out of space for LinkDish. Free up some space, or import without photos, and try again.",
  storage_unavailable:
    "LinkDish can't reach its storage on this device right now. Close other LinkDish tabs and try again.",
  write_failed:
    "We couldn't save the recipes on this device. Nothing was changed — please try again.",
  export_failed: "We couldn't put your backup together. Please try again.",
  backup_too_large:
    "With scanned photos this backup would be over 300 MB, too big for LinkDish to restore. Turn off scanned photos and download it again."
};

export class DataTransferError extends Error {
  public readonly code: DataTransferErrorCode;

  public constructor(code: DataTransferErrorCode, message: string = DEFAULT_MESSAGES[code]) {
    super(message);
    this.name = "DataTransferError";
    this.code = code;
  }
}

export const isDataTransferError = (error: unknown): error is DataTransferError =>
  error instanceof DataTransferError;

const errorName = (error: unknown): string =>
  typeof error === "object" && error !== null && "name" in error
    ? String((error as { name?: unknown }).name)
    : "";

/** True for the browser's "out of storage" failures (directly or as the cause of an abort). */
export const isStorageFullError = (error: unknown): boolean => {
  if (errorName(error) === "QuotaExceededError") {
    return true;
  }

  const inner =
    typeof error === "object" && error !== null
      ? ((error as { error?: unknown; cause?: unknown }).error ??
        (error as { cause?: unknown }).cause)
      : undefined;

  return inner !== undefined && inner !== error && errorName(inner) === "QuotaExceededError";
};

export type DataTransferPhase = "read" | "write" | "export";

/** One friendly sentence for anything thrown while reading, restoring or exporting. */
export const getDataTransferErrorMessage = (error: unknown, phase: DataTransferPhase): string => {
  if (isDataTransferError(error)) {
    return error.message;
  }

  if (isStorageFullError(error)) {
    return DEFAULT_MESSAGES.storage_full;
  }

  if (phase === "write") {
    const name = errorName(error);
    return name === "InvalidStateError" || name === "UnknownError"
      ? DEFAULT_MESSAGES.storage_unavailable
      : DEFAULT_MESSAGES.write_failed;
  }

  return phase === "export" ? DEFAULT_MESSAGES.export_failed : DEFAULT_MESSAGES.corrupt_file;
};
