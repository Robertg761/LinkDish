import React, { useId, useState } from "react";

import { Button } from "../../components/Button";
import { Icon } from "../../components/Icon";
import {
  COOK_MODE_DONE_LABEL,
  COOK_MODE_FINALE_TITLE,
  getCookModeFinaleMessage
} from "../../lib/flavor-copy";
import { RatingStars } from "../recipe-view/RecipeHero";

import type { RecipeRating } from "../library/saved-recipe-types";

interface CookFinishProps {
  recipeTitle: string;
  rating?: RecipeRating | null | undefined;
  onRate?: ((rating: RecipeRating | null) => void) | undefined;
  onLogCook?: ((entry: { note?: string | undefined }) => Promise<void>) | undefined;
  onAddIngredientsToShoppingList?: (() => void | Promise<void>) | undefined;
  onDone: () => void;
}

/** The celebration at the end of a cook: rate it, log it (with a note), restock, done. */
export const CookFinish: React.FC<CookFinishProps> = ({
  recipeTitle,
  rating,
  onRate,
  onLogCook,
  onAddIngredientsToShoppingList,
  onDone
}) => {
  const noteId = useId();
  const [note, setNote] = useState("");
  const [logging, setLogging] = useState(false);
  const [error, setError] = useState("");

  const logCook = async () => {
    if (!onLogCook) {
      return;
    }

    setLogging(true);
    setError("");

    try {
      const trimmed = note.trim();
      await onLogCook(trimmed ? { note: trimmed } : {});
    } catch {
      setError("That cook couldn’t be logged. Please try again.");
      setLogging(false);
    }
  };

  return (
    <div className="cook-finish">
      <div aria-hidden="true" className="cook-finish-burst">
        <span className="cook-finish-confetti" />
        <span className="cook-finish-icon">
          <Icon name="party-popper" size={34} strokeWidth={1.8} />
        </span>
      </div>
      <h2 className="cook-finish-title">{COOK_MODE_FINALE_TITLE}</h2>
      <p className="cook-finish-message">{getCookModeFinaleMessage(recipeTitle)}</p>

      {onRate ? (
        <div className="cook-finish-rating">
          <span className="cook-finish-label">How did it turn out?</span>
          <RatingStars label="Rate this recipe" onChange={onRate} size={30} value={rating} />
        </div>
      ) : null}

      {onLogCook ? (
        <div className="cook-finish-log">
          <label className="cook-finish-label" htmlFor={noteId}>
            Anything to remember next time? <span>(optional)</span>
          </label>
          <textarea
            id={noteId}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Doubled the garlic, 5 more minutes in the oven…"
            rows={2}
            value={note}
          />
          {error ? (
            <p className="cook-finish-error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="cook-finish-actions">
        {onLogCook ? (
          <Button
            fullWidth
            icon="check-circle"
            loading={logging}
            onClick={() => void logCook()}
            size="lg"
          >
            Log this cook
          </Button>
        ) : null}
        {onAddIngredientsToShoppingList ? (
          <Button
            fullWidth
            icon="shopping-basket"
            onClick={() => void onAddIngredientsToShoppingList()}
            variant="secondary"
          >
            Add ingredients to shopping list
          </Button>
        ) : null}
        <Button
          fullWidth
          onClick={onDone}
          variant={onLogCook ? "ghost" : "primary"}
          size={onLogCook ? "md" : "lg"}
        >
          {onLogCook ? "Close without logging" : COOK_MODE_DONE_LABEL}
        </Button>
      </div>
    </div>
  );
};
