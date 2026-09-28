import React from "react";

import { Icon } from "../../components/Icon";

import { getNutritionEntries } from "./recipe-view-format";

import type { Recipe } from "@linkdish/recipe-domain";

import "./NutritionCard.css";

/** Nutrition per serving as reported by the source, collapsed behind a summary line. */
export const NutritionCard: React.FC<{ nutrition: Recipe["nutrition"] }> = ({ nutrition }) => {
  const entries = getNutritionEntries(nutrition);

  if (entries.length === 0) {
    return null;
  }

  const calories = entries.find((entry) => entry.key === "calories");

  return (
    <details className="recipe-panel nutrition-card">
      <summary className="nutrition-card-summary">
        <span className="nutrition-card-heading">
          <span className="recipe-section-title">
            <Icon name="leaf" size={18} /> Nutrition
          </span>
          <span className="nutrition-card-peek num">
            {calories
              ? calories.value.replace(/\s*calories?$/iu, " cal")
              : `${entries.length} values`}
            <span className="nutrition-card-peek-hint"> per serving</span>
          </span>
        </span>
        <Icon className="nutrition-card-chevron" name="chevron-down" size={20} />
      </summary>
      <dl className="nutrition-card-grid">
        {entries.map((entry) => (
          <div className="nutrition-card-cell" key={entry.key}>
            <dt>{entry.label}</dt>
            <dd className="num">{entry.value}</dd>
          </div>
        ))}
      </dl>
      <p className="nutrition-card-footnote">
        As listed by the source. Scaling doesn’t change these.
      </p>
    </details>
  );
};
