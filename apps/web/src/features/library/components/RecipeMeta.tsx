import React from "react";

import { Icon } from "../../../components/Icon";

import { getRecipeFacts } from "./library-model";

import type { Recipe } from "@linkdish/recipe-domain";

/**
 * Card-sized meta with icons: "⏱ 35 min  👥 4–6" or "⏱ 24 min  36 cookies". Narrow grid cards
 * fit this where the spelled-out "35 min · Serves 4–6" would be cut off.
 */
export const CompactRecipeMeta: React.FC<{ recipe: Recipe }> = ({ recipe }) => {
  const facts = getRecipeFacts(recipe);

  if (!facts.totalLabel && !facts.servingsShort) {
    return null;
  }

  return (
    <>
      {facts.totalLabel ? (
        <span className="library-meta-item">
          <Icon className="library-meta-icon" name="clock" size={13} strokeWidth={2.2} />
          {facts.totalLabel}
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
