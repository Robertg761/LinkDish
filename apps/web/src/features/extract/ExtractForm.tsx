import React, { useRef, useState } from "react";
import { createPortal } from "react-dom";

import { Button } from "../../components/Button";
import { Field } from "../../components/Field";
import { Icon } from "../../components/Icon";
import "./ExtractForm.css";

import type { ExtractRecipeImage } from "@linkdish/api-contracts";

interface ExtractFormProps {
  onSubmit: (url: string) => void;
  onImagesSubmit?: (images: ExtractRecipeImage[]) => void | Promise<void>;
  loading: boolean;
}

const MAX_IMAGE_IMPORTS = 4;
const MAX_IMAGE_DATA_URL_LENGTH = 4_500_000;
const MAX_IMAGE_IMPORT_PAYLOAD_LENGTH = 8_000_000;
const PAYLOAD_SIZE_CHECK_SOURCE_URL =
  "https://linkdish.app/image-imports/web-0000000000000-00000000";

const fileToDataUrl = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }

      reject(new Error("File could not be read as an image."));
    });
    reader.addEventListener("error", () => reject(reader.error ?? new Error("File read failed.")));
    reader.readAsDataURL(file);
  });

const getImageMimeType = (file: File): ExtractRecipeImage["mimeType"] =>
  file.type === "image/png" || file.type === "image/webp" ? file.type : "image/jpeg";

export const ExtractForm: React.FC<ExtractFormProps> = ({ onSubmit, onImagesSubmit, loading }) => {
  const [urlInput, setUrlInput] = useState("");
  const [error, setError] = useState("");
  const [imageLoading, setImageLoading] = useState(false);
  const [nudgeInput, setNudgeInput] = useState(false);
  const [scanOptionsOpen, setScanOptionsOpen] = useState(false);
  const cameraFileInputRef = useRef<HTMLInputElement | null>(null);
  const libraryFileInputRef = useRef<HTMLInputElement | null>(null);
  const urlInputRef = useRef<HTMLInputElement | null>(null);

  const cleanUrlInput = (input: string): string => {
    const trimmed = input.trim();
    // Regex to extract URL from text in case user pasted a share sheet message
    const urlRegex = /(https?:\/\/[^\s]+)/gi;
    const match = trimmed.match(urlRegex);
    if (match && match[0]) {
      return match[0];
    }
    return trimmed;
  };

  const handleFormSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    const cleanedUrl = cleanUrlInput(urlInput);
    const focusAndNudgeInput = () => {
      urlInputRef.current?.focus();
      setNudgeInput(false);
      const scheduleNudge =
        typeof requestAnimationFrame === "function"
          ? requestAnimationFrame
          : (callback: FrameRequestCallback) => window.setTimeout(callback, 0);
      scheduleNudge(() => setNudgeInput(true));
    };

    if (!cleanedUrl) {
      setError("Please paste a recipe link.");
      focusAndNudgeInput();
      return;
    }

    try {
      const parsedUrl = new URL(cleanedUrl);
      if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
        setError("Only HTTP and HTTPS links are supported.");
        focusAndNudgeInput();
        return;
      }

      onSubmit(cleanedUrl);
    } catch {
      setError("Please enter a valid URL (e.g. https://example.com/recipe).");
      focusAndNudgeInput();
    }
  };

  const isBusy = loading || imageLoading;

  const clearImageInputs = () => {
    if (cameraFileInputRef.current) {
      cameraFileInputRef.current.value = "";
    }

    if (libraryFileInputRef.current) {
      libraryFileInputRef.current.value = "";
    }
  };

  const openScanOptions = () => {
    if (isBusy || !onImagesSubmit) {
      return;
    }

    setScanOptionsOpen(true);
  };

  const chooseImageSource = (source: "camera" | "library") => {
    setScanOptionsOpen(false);

    if (source === "camera") {
      cameraFileInputRef.current?.click();
      return;
    }

    libraryFileInputRef.current?.click();
  };

  const handleImageFiles = async (files: FileList | null) => {
    setError("");

    if (!onImagesSubmit || !files || files.length === 0) {
      return;
    }

    setImageLoading(true);

    try {
      const selectedFiles = Array.from(files)
        .filter((file) => file.type.startsWith("image/"))
        .slice(0, MAX_IMAGE_IMPORTS);
      const images = (
        await Promise.all(
          selectedFiles.map(async (file) => {
            const dataUrl = await fileToDataUrl(file);

            if (dataUrl.length > MAX_IMAGE_DATA_URL_LENGTH) {
              return null;
            }

            return {
              dataUrl,
              mimeType: getImageMimeType(file)
            };
          })
        )
      ).filter((image): image is ExtractRecipeImage => image !== null);
      const payloadLength = JSON.stringify({
        attempt: "fallback",
        images,
        sourceUrl: PAYLOAD_SIZE_CHECK_SOURCE_URL
      }).length;

      if (images.length === 0 || payloadLength > MAX_IMAGE_IMPORT_PAYLOAD_LENGTH) {
        setError("That image was too large or could not be read. Try a clearer photo.");
        return;
      }

      await onImagesSubmit(images);
    } catch {
      setError("LinkDish could not open image scanning. Try again.");
    } finally {
      setImageLoading(false);
      clearImageInputs();
    }
  };

  return (
    <form onSubmit={handleFormSubmit} className="extract-form">
      <input
        ref={cameraFileInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        onChange={(event) => {
          void handleImageFiles(event.target.files);
        }}
      />
      <input
        ref={libraryFileInputRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(event) => {
          void handleImageFiles(event.target.files);
        }}
      />
      <Field
        className={nudgeInput ? "extract-url-field-nudge" : ""}
        inputRef={urlInputRef}
        placeholder="https://example.com/my-recipe"
        value={urlInput}
        onAnimationEnd={() => setNudgeInput(false)}
        onChange={(e) => {
          setUrlInput(e.target.value);
          setNudgeInput(false);
        }}
        error={error}
        disabled={isBusy}
        type="text"
        id="recipe-url-input"
        rightElement={
          <button
            type="button"
            className="extract-camera-btn"
            aria-label="Scan recipe"
            disabled={isBusy || !onImagesSubmit}
            onClick={openScanOptions}
          >
            <Icon name="camera-outline" size={22} color="var(--color-accent)" />
          </button>
        }
      />

      <Button type="submit" loading={isBusy} disabled={isBusy} fullWidth>
        {imageLoading ? "Scanning recipe" : "Extract recipe"}
      </Button>

      {scanOptionsOpen &&
        createPortal(
          <div className="scan-options-overlay">
            <button
              type="button"
              className="scan-options-backdrop"
              aria-label="Close scan options"
              onClick={() => setScanOptionsOpen(false)}
            />
            <div
              className="scan-options-sheet"
              role="dialog"
              aria-modal="true"
              aria-labelledby="scan-options-title"
            >
              <h2 className="scan-options-title" id="scan-options-title">
                Scan Recipe
              </h2>
              <button
                type="button"
                className="scan-options-row"
                onClick={() => chooseImageSource("camera")}
              >
                <span className="scan-options-icon">
                  <Icon name="camera-outline" size={24} color="var(--color-accent)" />
                </span>
                <span className="scan-options-copy">
                  <span className="scan-options-row-title">Take photo</span>
                  <span className="scan-options-row-desc">Scan physical cookbooks or paper</span>
                </span>
              </button>
              <button
                type="button"
                className="scan-options-row"
                onClick={() => chooseImageSource("library")}
              >
                <span className="scan-options-icon">
                  <Icon name="image-multiple-outline" size={24} color="var(--color-accent)" />
                </span>
                <span className="scan-options-copy">
                  <span className="scan-options-row-title">Choose from Library</span>
                  <span className="scan-options-row-desc">Select saved screenshot or photo</span>
                </span>
              </button>
              <button
                type="button"
                className="scan-options-cancel"
                onClick={() => setScanOptionsOpen(false)}
              >
                Cancel
              </button>
            </div>
          </div>,
          document.body
        )}
    </form>
  );
};
