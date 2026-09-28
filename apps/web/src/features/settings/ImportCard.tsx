import React, { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { Button } from "../../components/Button";
import { Icon } from "../../components/Icon";
import { IMPORT_FILE_ACCEPT } from "../data-transfer/import-formats";
import { useUpgradeSheet } from "../upgrade/UpgradeSheet";

import { ImportSheet } from "./ImportSheet";

interface ImportCardProps {
  isPremium: boolean;
}

const FORMATS: ReadonlyArray<{ label: string; extension: string }> = [
  { label: "LinkDish backup", extension: ".json" },
  { label: "Paprika", extension: ".paprikarecipes" },
  { label: "Mela", extension: ".melarecipes" },
  { label: "Recipe JSON-LD", extension: ".json" }
];

export const ImportCard: React.FC<ImportCardProps> = ({ isPremium }) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const { requestUpgradeSheet } = useUpgradeSheet();
  const navigate = useNavigate();

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

      <ul aria-label="Files LinkDish can import" className="settings-import-formats">
        {FORMATS.map((format) => (
          <li className="settings-import-format" key={format.label}>
            <span>{format.label}</span>
            <span className="settings-import-format-extension">{format.extension}</span>
          </li>
        ))}
      </ul>

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
        <Button icon="upload" onClick={() => inputRef.current?.click()} variant="secondary">
          Choose a file
        </Button>
        <span className="settings-data-footnote settings-import-hint">
          <Icon name="lock" size={14} />
          Read on this device — nothing is uploaded.
        </span>
      </div>

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
    </div>
  );
};
