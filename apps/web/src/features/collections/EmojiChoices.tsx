import React from "react";

import { COLLECTION_EMOJI_CHOICES } from "./collection-helpers";

interface EmojiChoicesProps {
  label: string;
  value: string | undefined;
  onChange: (emoji: string | undefined) => void;
}

/** A row of emoji quick picks (a radio group); picking the chosen one again clears it. */
export const EmojiChoices: React.FC<EmojiChoicesProps> = ({ label, value, onChange }) => {
  const choices: readonly string[] =
    value && !(COLLECTION_EMOJI_CHOICES as readonly string[]).includes(value)
      ? [value, ...COLLECTION_EMOJI_CHOICES]
      : COLLECTION_EMOJI_CHOICES;

  return (
    <div aria-label={label} className="emoji-choices" role="radiogroup">
      {choices.map((emoji) => {
        const selected = emoji === value;

        return (
          <button
            aria-checked={selected}
            aria-label={emoji}
            className={`emoji-choice${selected ? " is-selected" : ""}`}
            key={emoji}
            onClick={() => onChange(selected ? undefined : emoji)}
            role="radio"
            type="button"
          >
            {emoji}
          </button>
        );
      })}
    </div>
  );
};
