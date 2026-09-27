import React from "react";

import { Icon } from "../../components/Icon";

import type { IconName } from "../../components/Icon";

import "./FamilyExplainer.css";

const SAMPLE_RECIPES: ReadonlyArray<{ title: string; meta: string; who: string; tint: number }> = [
  { meta: "Added by Ana", title: "Sunday roast chicken", tint: 0, who: "AN" },
  { meta: "Added by Jo", title: "Weeknight red lentil dal", tint: 1, who: "JO" },
  { meta: "Added by you", title: "Lemon ricotta pancakes", tint: 2, who: "YO" }
];

const SAMPLE_LIST: ReadonlyArray<{ text: string; done: boolean; who: string; tint: number }> = [
  { done: true, text: "Lemons", tint: 0, who: "AN" },
  { done: false, text: "Basmati rice", tint: 1, who: "JO" },
  { done: true, text: "Ricotta", tint: 2, who: "YO" },
  { done: false, text: "Chicken thighs", tint: 0, who: "AN" }
];

const FACTS: ReadonlyArray<{ icon: IconName; title: string; body: string }> = [
  {
    body: "You and up to five more. Partners, roommates, kids, grandparents.",
    icon: "users",
    title: "Up to 6 people"
  },
  {
    body: "Invite them by email. They join with a free LinkDish account.",
    icon: "mail",
    title: "Invite by email"
  },
  {
    body: "One Family plan covers everyone, including 250 imports a month.",
    icon: "crown",
    title: "One plan for all"
  }
];

interface FamilyExplainerProps {
  /** The main call to action (upgrade, create or sign in). */
  action?: React.ReactNode;
  /** Small print under the action. */
  actionNote?: React.ReactNode;
}

/** Shows what a Family household looks like before someone has one. */
export const FamilyExplainer: React.FC<FamilyExplainerProps> = ({ action, actionNote }) => (
  <section aria-labelledby="family-explainer-title" className="family-explainer">
    <div className="family-explainer-previews">
      <figure className="family-preview">
        <figcaption className="family-preview-caption">
          <Icon name="book-open" size={16} />
          One shared cookbook
        </figcaption>
        <ul aria-hidden="true" className="family-preview-list">
          {SAMPLE_RECIPES.map((recipe) => (
            <li className="family-preview-recipe" key={recipe.title}>
              <span className={`family-preview-thumb family-tint-${recipe.tint}`}>
                <Icon name={recipe.tint === 2 ? "chef-hat" : "utensils"} size={16} />
              </span>
              <span className="family-preview-recipe-copy">
                <span className="family-preview-recipe-title">{recipe.title}</span>
                <span className="family-preview-recipe-meta">{recipe.meta}</span>
              </span>
            </li>
          ))}
        </ul>
      </figure>

      <figure className="family-preview">
        <figcaption className="family-preview-caption">
          <Icon name="shopping-basket" size={16} />
          One shopping list, always in sync
        </figcaption>
        <ul aria-hidden="true" className="family-preview-list">
          {SAMPLE_LIST.map((item) => (
            <li className={`family-preview-item${item.done ? " is-done" : ""}`} key={item.text}>
              <span className="family-preview-check">
                {item.done ? <Icon name="check" size={13} strokeWidth={3} /> : null}
              </span>
              <span className="family-preview-item-text">{item.text}</span>
              <span className={`family-preview-avatar family-tint-${item.tint}`}>{item.who}</span>
            </li>
          ))}
        </ul>
      </figure>
    </div>

    <div className="family-explainer-copy">
      <h2 className="family-explainer-title" id="family-explainer-title">
        How a household works
      </h2>
      <ul className="family-facts">
        {FACTS.map((fact) => (
          <li className="family-fact" key={fact.title}>
            <span className="family-fact-icon">
              <Icon name={fact.icon} size={18} />
            </span>
            <span className="family-fact-copy">
              <strong>{fact.title}</strong>
              <span>{fact.body}</span>
            </span>
          </li>
        ))}
      </ul>
      {action ? <div className="family-explainer-action">{action}</div> : null}
      {actionNote ? <p className="family-explainer-note">{actionNote}</p> : null}
    </div>
  </section>
);
