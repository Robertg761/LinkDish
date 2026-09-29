import React, { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "../../components/Button";
import { Icon } from "../../components/Icon";
import { IconButton } from "../../components/IconButton";

import { PHOTO_PREP_MESSAGES, PhotoPrepError, prepareRecipePhoto } from "./image-downscale";
import { MAX_IMPORT_PHOTOS } from "./import-input";

import type { PreparedPhoto } from "./image-downscale";
import type { ExtractRecipeImage } from "@linkdish/api-contracts";

interface PhotoItem {
  id: string;
  name: string;
  previewUrl: string | null;
  status: "preparing" | "ready" | "error";
  photo?: PreparedPhoto | undefined;
  error?: string | undefined;
}

interface ImportPhotoPanelProps {
  disabled?: boolean | undefined;
  focusRequest?: number | undefined;
  onImport: (images: ExtractRecipeImage[]) => void;
}

const createPreviewUrl = (file: File): string | null => {
  try {
    return URL.createObjectURL(file);
  } catch {
    return null;
  }
};

const revoke = (url: string | null) => {
  if (url?.startsWith("blob:")) {
    URL.revokeObjectURL(url);
  }
};

/**
 * Photos of a cookbook page or screenshots: up to four, shown as numbered thumbnails that can be
 * reordered or removed. Each one is shrunk in the browser as soon as it's picked, so sending is
 * quick and far below the upload limits. Photo imports are never retried automatically.
 */
export const ImportPhotoPanel: React.FC<ImportPhotoPanelProps> = ({
  disabled = false,
  focusRequest,
  onImport
}) => {
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const libraryInputRef = useRef<HTMLInputElement>(null);
  const chooseButtonRef = useRef<HTMLButtonElement>(null);
  const [items, setItems] = useState<PhotoItem[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const itemsRef = useRef(items);
  itemsRef.current = items;

  useEffect(
    () => () => {
      itemsRef.current.forEach((item) => revoke(item.previewUrl));
    },
    []
  );

  useEffect(() => {
    if (focusRequest) {
      chooseButtonRef.current?.focus();
    }
  }, [focusRequest]);

  const addFiles = useCallback((files: FileList | File[] | null) => {
    const picked = Array.from(files ?? []);

    if (picked.length === 0) {
      return;
    }

    const room = MAX_IMPORT_PHOTOS - itemsRef.current.length;
    const accepted = picked.slice(0, Math.max(room, 0));
    setNotice(
      picked.length > accepted.length
        ? `Up to ${MAX_IMPORT_PHOTOS} photos per recipe. We kept the first ${accepted.length || "few"}.`
        : null
    );

    const fresh: PhotoItem[] = accepted.map((file) => ({
      id: crypto.randomUUID(),
      name: file.name,
      previewUrl: createPreviewUrl(file),
      status: "preparing"
    }));
    setItems((current) => [...current, ...fresh]);

    fresh.forEach((item, index) => {
      const file = accepted[index];

      if (!file) {
        return;
      }

      prepareRecipePhoto(file).then(
        (photo) => {
          setItems((current) =>
            current.map((entry) => {
              if (entry.id !== item.id) {
                return entry;
              }

              revoke(entry.previewUrl);
              return { ...entry, photo, previewUrl: photo.dataUrl, status: "ready" };
            })
          );
        },
        (error: unknown) => {
          const message =
            error instanceof PhotoPrepError ? error.message : PHOTO_PREP_MESSAGES.unreadable;
          setItems((current) =>
            current.map((entry) =>
              entry.id === item.id ? { ...entry, error: message, status: "error" } : entry
            )
          );
        }
      );
    });
  }, []);

  const remove = (id: string) => {
    setItems((current) => {
      const target = current.find((item) => item.id === id);
      revoke(target?.previewUrl ?? null);
      return current.filter((item) => item.id !== id);
    });
    setNotice(null);
  };

  const move = (index: number, offset: -1 | 1) => {
    setItems((current) => {
      const next = [...current];
      const target = index + offset;
      const [moved] = next.splice(index, 1);

      if (!moved || target < 0 || target > next.length) {
        return current;
      }

      next.splice(target, 0, moved);
      return next;
    });
  };

  const readyPhotos = items.filter((item) => item.status === "ready" && item.photo);
  const preparing = items.some((item) => item.status === "preparing");
  const failed = items.filter((item) => item.status === "error");
  const canSubmit = !disabled && !preparing && readyPhotos.length > 0 && failed.length === 0;

  const submit = () => {
    if (!canSubmit) {
      return;
    }

    onImport(
      readyPhotos.flatMap((item) =>
        item.photo ? [{ dataUrl: item.photo.dataUrl, mimeType: item.photo.mimeType }] : []
      )
    );
  };

  const openPicker = (kind: "camera" | "library") => {
    (kind === "camera" ? cameraInputRef : libraryInputRef).current?.click();
  };

  const dropHandlers = {
    onDragLeave: (event: React.DragEvent) => {
      if (event.currentTarget === event.target) {
        setDragging(false);
      }
    },
    onDragOver: (event: React.DragEvent) => {
      if (Array.from(event.dataTransfer.types).includes("Files")) {
        event.preventDefault();
        setDragging(true);
      }
    },
    onDrop: (event: React.DragEvent) => {
      event.preventDefault();
      setDragging(false);

      if (!disabled) {
        addFiles(event.dataTransfer.files);
      }
    }
  };

  return (
    <div className="import-photos">
      <input
        accept="image/*,.heic,.heif"
        capture="environment"
        hidden
        onChange={(event) => {
          addFiles(event.target.files);
          event.target.value = "";
        }}
        ref={cameraInputRef}
        type="file"
      />
      <input
        accept="image/*,.heic,.heif"
        hidden
        multiple
        onChange={(event) => {
          addFiles(event.target.files);
          event.target.value = "";
        }}
        ref={libraryInputRef}
        type="file"
      />

      {items.length === 0 ? (
        <div className={`import-photos-drop${dragging ? " is-dragging" : ""}`} {...dropHandlers}>
          <span aria-hidden="true" className="import-photos-drop-art">
            <Icon name="camera" size={26} />
          </span>
          <p className="import-photos-drop-title">Snap a cookbook page or a screenshot</p>
          <p className="import-photos-drop-body">
            Up to {MAX_IMPORT_PHOTOS} photos, in page order. We shrink them on your device before
            sending.
          </p>
          <div className="import-photos-drop-actions">
            <Button
              className="import-photos-take"
              disabled={disabled}
              icon="camera"
              onClick={() => openPicker("camera")}
              variant="primary"
            >
              Take a photo
            </Button>
            <Button
              disabled={disabled}
              icon="images"
              onClick={() => openPicker("library")}
              ref={chooseButtonRef}
              variant="secondary"
            >
              Choose photos
            </Button>
          </div>
          <p className="import-photos-drop-hint">or drop them here</p>
        </div>
      ) : (
        <>
          <ol
            aria-label="Photos to read, in order"
            className={`import-photos-grid${dragging ? " is-dragging" : ""}`}
            {...dropHandlers}
          >
            {items.map((item, index) => (
              <li className={`import-photos-tile is-${item.status}`} key={item.id}>
                {item.previewUrl && item.status !== "error" ? (
                  <img
                    alt={`Photo ${index + 1}`}
                    className="import-photos-image"
                    src={item.previewUrl}
                  />
                ) : (
                  <span aria-hidden="true" className="import-photos-placeholder">
                    <Icon name="image" size={28} />
                  </span>
                )}
                <span className="import-photos-number num">{index + 1}</span>
                {item.status === "preparing" ? (
                  <span className="import-photos-status" role="status">
                    <Icon className="extract-result-spin" name="loader" size={16} /> Preparing…
                  </span>
                ) : null}
                {item.status === "error" ? (
                  <span className="import-photos-status is-error">
                    <Icon name="alert-circle" size={16} /> Can’t open
                  </span>
                ) : null}
                <div className="import-photos-tile-actions">
                  <IconButton
                    aria-label={`Move photo ${index + 1} earlier`}
                    disabled={index === 0}
                    icon="chevron-left"
                    onClick={() => move(index, -1)}
                    size="sm"
                    variant="filled"
                  />
                  <IconButton
                    aria-label={`Move photo ${index + 1} later`}
                    disabled={index === items.length - 1}
                    icon="chevron-right"
                    onClick={() => move(index, 1)}
                    size="sm"
                    variant="filled"
                  />
                  <IconButton
                    aria-label={`Remove photo ${index + 1}`}
                    icon="x"
                    onClick={() => remove(item.id)}
                    size="sm"
                    variant="filled"
                  />
                </div>
              </li>
            ))}
            {items.length < MAX_IMPORT_PHOTOS ? (
              <li className="import-photos-add-tile">
                <button
                  className="import-photos-add"
                  disabled={disabled}
                  onClick={() => openPicker("library")}
                  ref={chooseButtonRef}
                  type="button"
                >
                  <Icon name="plus" size={22} />
                  <span>Add a page</span>
                </button>
              </li>
            ) : null}
          </ol>

          {failed.length > 0 ? (
            <p className="import-link-error" role="alert">
              <Icon name="alert-circle" size={16} />
              {failed[0]?.error ?? PHOTO_PREP_MESSAGES.unreadable}
              {readyPhotos.length > 0 ? " Remove it to carry on with the rest." : ""}
            </p>
          ) : notice ? (
            <p className="import-link-hint is-batch" role="status">
              <Icon name="info" size={16} />
              {notice}
            </p>
          ) : (
            <p className="import-link-hint">
              Pages are read in this order. Use the arrows to reorder them.
            </p>
          )}

          <Button
            className="import-photos-submit"
            disabled={!canSubmit}
            fullWidth
            icon="scan"
            loading={preparing}
            onClick={submit}
            size="lg"
            variant="accent"
          >
            {preparing
              ? "Preparing photos"
              : `Read the recipe${readyPhotos.length > 1 ? ` from ${readyPhotos.length} photos` : ""}`}
          </Button>
        </>
      )}
    </div>
  );
};
