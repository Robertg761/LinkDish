import React, { Suspense, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { Button } from "../../components/Button";
import { Icon } from "../../components/Icon";
import { useToast } from "../../components/Toast";
import { lazyWithRetry } from "../../platform/lazy";
import { OptionalChunkBoundary } from "../../platform/OptionalChunkBoundary";
import { IMPORT_FILE_ACCEPT } from "../data-transfer/import-formats";
import { useUpgradeSheet } from "../upgrade/UpgradeSheet";

interface ImportCardProps {
  isPremium: boolean;
}

// The preview sheet (and the import code it loads) is only needed once a file is chosen.
const ImportSheet = lazyWithRetry(() =>
  import("./ImportSheet").then((module) => ({ default: module.ImportSheet }))
);

export const ImportCard: React.FC<ImportCardProps> = ({ isPremium }) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const { requestUpgradeSheet } = useUpgradeSheet();
  const { showToast } = useToast();
  const navigate = useNavigate();
  const preloadImporter = () => {
    ImportSheet.preload().catch(() => undefined);
  };

  const chooseFile = (next: File | undefined | null) => {
    if (next) {
      setFile(next);
    }
  };

  const handleUpgrade = () => {
    if (!requestUpgradeSheet("save_limit")) {
      // Already seen this session (or the sheet is unavailable): go to the plans instead.
      void navigate("/pricing");
    }
  };

  return (
    <div
      className={`settings-card settings-data-card settings-import-card${dragging ? " is-dragging" : ""}`}
      data-testid="import-card"
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setDragging(false);
        }
      }}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("Files")) {
          event.preventDefault();
          setDragging(true);
        }
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        chooseFile(event.dataTransfer.files[0]);
      }}
    >
      <div className="settings-data-card-header">
        <span className="settings-data-card-icon settings-data-card-icon-butter" aria-hidden="true">
          <Icon name="upload" size={20} />
        </span>
        <div className="settings-data-card-heading">
          <h3 className="settings-data-card-title">Import recipes</h3>
          <p className="settings-data-card-text">
            Restore a LinkDish backup, or move your cookbook over from another app. You'll see
            what's inside before anything is added.
          </p>
        </div>
      </div>

      {/* Plain words, not pills: these are the files it reads, not buttons. */}
      <p className="settings-data-card-text settings-import-formats">
        Works with LinkDish backups, Paprika, Mela and recipe files saved from other apps and
        websites.
      </p>

      <input
        accept={IMPORT_FILE_ACCEPT}
        aria-hidden="true"
        className="sr-only"
        data-testid="import-file-input"
        onChange={(event) => {
          chooseFile(event.target.files?.[0]);
          // Let the same file be picked again later.
          event.target.value = "";
        }}
        ref={inputRef}
        tabIndex={-1}
        type="file"
      />

      <div className="settings-data-actions">
        <Button
          icon="upload"
          onClick={() => {
            preloadImporter();
            inputRef.current?.click();
          }}
          onFocus={preloadImporter}
          onPointerEnter={preloadImporter}
          variant="secondary"
        >
          Choose a file
        </Button>
        <span className="settings-data-footnote settings-import-hint">
          <Icon name="lock" size={14} />
          Read on this device — nothing is uploaded.
        </span>
      </div>

      {file ? (
        <OptionalChunkBoundary
          key={`${file.name}-${file.size}-${file.lastModified}`}
          name="Import preview"
          onError={() => {
            setFile(null);
            showToast({
              icon: "wifi-off",
              message: "We couldn't open the importer. Check your connection and try again.",
              tone: "danger"
            });
          }}
        >
          <Suspense fallback={null}>
            <ImportSheet
              file={file}
              isPremium={isPremium}
              onChooseAnother={() => {
                setFile(null);
                inputRef.current?.click();
              }}
              onClose={() => setFile(null)}
              onUpgrade={handleUpgrade}
            />
          </Suspense>
        </OptionalChunkBoundary>
      ) : null}
    </div>
  );
};
