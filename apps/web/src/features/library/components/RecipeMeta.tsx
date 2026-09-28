import React from "react";

import { Icon } from "../../../components/Icon";

import { getRecipeFacts } from "./library-model";

import type { Recipe } from "@linkdish/recipe-domain";

/**
 * Card-sized meta with icons: "⏱ 35 min  👥 4–6", "⏱ 1h 20m  👥 6" or "⏱ 10 min  9 pancakes".
 * Each item stays whole: on a card too narrow for both, the servings item is dropped rather than
 * cut off mid-word (see `.recipe-card-meta` in LibraryPage.css).
 */
export const CompactRecipeMeta: React.FC<{ recipe: Recipe }> = ({ recipe }) => {
  const facts = getRecipeFacts(recipe);

  if (!facts.totalShort && !facts.servingsShort) {
    return null;
  }

  return (
    <>
      {facts.totalShort ? (
        <span className="library-meta-item">
          <Icon className="library-meta-icon" name="clock" size={13} strokeWidth={2.2} />
          {facts.totalShort}
        </span>
      ) : null}
      {facts.servingsShort ? (
        <span className="library-meta-item">
          {facts.servingsArePeople ? (
            <>
              <Icon className="library-meta-icon" name="users" size={13} strokeWidth={2.2} />
              <span className="sr-only">Serves </span>
            </>
          ) : null}
          {facts.servingsShort}
        </span>
      ) : null}
    </>
  );
};

/**
 * The list row's meta, "35 min · Serves 4 · seriouseats.com", as whole items: when the row is
 * too narrow the source drops out instead of ending in "bonappe…".
 */
export const RecipeMetaLine: React.FC<{ recipe: Recipe }> = ({ recipe }) => {
  const facts = getRecipeFacts(recipe);
  const parts = [facts.totalLabel, facts.servingsLabel, facts.sourceLabel].filter(
    (part): part is string => Boolean(part)
  );

  return (
    <>
      {parts.map((part, index) => (
        <span className="library-meta-item" key={part}>
          {index > 0 ? (
            <span aria-hidden="true" className="library-meta-sep">
              ·
            </span>
          ) : null}
          {part}
        </span>
      ))}
    </>
  );
};
