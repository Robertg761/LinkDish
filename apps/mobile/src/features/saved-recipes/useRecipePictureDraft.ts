import * as ImagePicker from "expo-image-picker";
import { useCallback, useRef, useState } from "react";

import { buildProxiedRecipeImageUrl } from "../../lib/recipeImage";
import { prepareRecipePicture } from "../recipe-intake/preparePickedImages";

import type { RecipeImage } from "@linkdish/recipe-domain";

/** What happens to the recipe's picture on save. `uploaded` keeps a retry from sending it twice. */
type RecipePictureDraft =
  | { kind: "keep" }
  | { kind: "remove" }
  | { dataUrl: string; kind: "new"; previewUri: string; uploaded?: RecipeImage };

const KEEP: RecipePictureDraft = { kind: "keep" };

/**
 * The recipe editor's picture: chosen and shown right away, but only sent on save, so backing out
 * of the editor leaves nothing stored.
 */
export const useRecipePictureDraft = (upload: (dataUrl: string) => Promise<RecipeImage>) => {
  const [draft, setDraft] = useState<RecipePictureDraft>(KEEP);
  const [error, setError] = useState<string | null>(null);
  const [isPreparing, setIsPreparing] = useState(false);
  /** Moves on whenever a picture being prepared stops mattering, so its result is dropped. */
  const runRef = useRef(0);

  const settle = useCallback((next: RecipePictureDraft) => {
    runRef.current += 1;
    setDraft(next);
    setError(null);
    setIsPreparing(false);
  }, []);

  const reset = useCallback(() => settle(KEEP), [settle]);
  const remove = useCallback(() => settle({ kind: "remove" }), [settle]);

  const choose = useCallback(async () => {
    runRef.current += 1;
    const run = runRef.current;
    const isCurrent = () => run === runRef.current;

    setError(null);

    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        base64: false,
        mediaTypes: ["images"],
        quality: 0.8
      });
      const asset = result.canceled ? undefined : result.assets[0];

      if (asset && isCurrent()) {
        setIsPreparing(true);
        const dataUrl = await prepareRecipePicture(asset);

        if (isCurrent()) {
          setDraft({ dataUrl, kind: "new", previewUri: asset.uri });
        }
      }
    } catch {
      if (isCurrent()) {
        setError("That picture could not be opened. Try another one.");
      }
    } finally {
      if (isCurrent()) {
        setIsPreparing(false);
      }
    }
  }, []);

  /** What to show for a recipe whose saved picture is `current`. */
  const preview = (current: RecipeImage | null): string | null =>
    draft.kind === "new"
      ? draft.previewUri
      : draft.kind === "remove"
        ? null
        : buildProxiedRecipeImageUrl(current, 480);

  /** The picture to save, uploading a chosen one. Rejects when the upload fails. */
  const resolve = async (current: RecipeImage | null): Promise<RecipeImage | null> => {
    if (draft.kind !== "new") {
      return draft.kind === "remove" ? null : current;
    }

    const uploaded = draft.uploaded ?? (await upload(draft.dataUrl));
    setDraft({ ...draft, uploaded });
    return uploaded;
  };

  return { choose, error, isPreparing, preview, remove, reset, resolve };
};
