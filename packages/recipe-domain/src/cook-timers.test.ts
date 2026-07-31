import { describe, expect, it } from "vitest";

import { parseStepDurations, SAMPLE_RECIPES } from "./index";

const minute = 60;
const hour = 60 * minute;

type ExpectedDuration = {
  label: string;
  minSeconds: number;
  maxSeconds: number;
};

const durationCorpus: Array<{ text: string; expected: ExpectedDuration[] }> = [
  {
    text: "Bake until the top is set, 30 minutes.",
    expected: [{ label: "30 minutes", minSeconds: 30 * minute, maxSeconds: 30 * minute }]
  },
  {
    text: "Roast the squash for 30-35 minutes, turning once.",
    expected: [{ label: "30-35 minutes", minSeconds: 30 * minute, maxSeconds: 35 * minute }]
  },
  {
    text: "Simmer gently for 30 to 35 minutes.",
    expected: [{ label: "30 to 35 minutes", minSeconds: 30 * minute, maxSeconds: 35 * minute }]
  },
  {
    text: "Let the dough rest 1 hour before shaping.",
    expected: [{ label: "1 hour", minSeconds: hour, maxSeconds: hour }]
  },
  {
    text: "Chill the custard for 1 1/2 hours.",
    expected: [{ label: "1 1/2 hours", minSeconds: 90 * minute, maxSeconds: 90 * minute }]
  },
  {
    text: "Blanch the beans for 90 seconds, then shock in ice water.",
    expected: [{ label: "90 seconds", minSeconds: 90, maxSeconds: 90 }]
  },
  {
    text: "Sear the steak 2-3 min per side.",
    expected: [{ label: "2-3 min per side", minSeconds: 2 * minute, maxSeconds: 3 * minute }]
  },
  {
    text: "Cook about 20 min, stirring halfway through.",
    expected: [{ label: "about 20 min", minSeconds: 20 * minute, maxSeconds: 20 * minute }]
  },
  {
    text: "Return to the oven for another 10 minutes.",
    expected: [{ label: "another 10 minutes", minSeconds: 10 * minute, maxSeconds: 10 * minute }]
  },
  {
    text: "Whisk until glossy, about 1 minute.",
    expected: [{ label: "about 1 minute", minSeconds: minute, maxSeconds: minute }]
  },
  {
    text: "Toast the spices for 45 sec.",
    expected: [{ label: "45 sec", minSeconds: 45, maxSeconds: 45 }]
  },
  {
    text: "Steam the clams 6–8 minutes.",
    expected: [{ label: "6–8 minutes", minSeconds: 6 * minute, maxSeconds: 8 * minute }]
  },
  {
    text: "Bake 25–30 minutes, until bubbling at the edges.",
    expected: [{ label: "25–30 minutes", minSeconds: 25 * minute, maxSeconds: 30 * minute }]
  },
  {
    text: "Cool for at least 30 minutes before slicing.",
    expected: [{ label: "at least 30 minutes", minSeconds: 30 * minute, maxSeconds: 30 * minute }]
  },
  {
    text: "Let the rice sit up to 10 minutes off heat.",
    expected: [{ label: "up to 10 minutes", minSeconds: 10 * minute, maxSeconds: 10 * minute }]
  },
  {
    text: "Boil rapidly for approximately 7 mins.",
    expected: [{ label: "approximately 7 mins", minSeconds: 7 * minute, maxSeconds: 7 * minute }]
  },
  {
    text: "Stir the caramel around 12 minutes until amber.",
    expected: [{ label: "around 12 minutes", minSeconds: 12 * minute, maxSeconds: 12 * minute }]
  },
  {
    text: "Proof for roughly 2 hours at room temperature.",
    expected: [{ label: "roughly 2 hours", minSeconds: 2 * hour, maxSeconds: 2 * hour }]
  },
  {
    text: "Let the skillet preheat for an additional 5 minutes.",
    expected: [{ label: "an additional 5 minutes", minSeconds: 5 * minute, maxSeconds: 5 * minute }]
  },
  {
    text: "Shake the pan every 30 secs.",
    expected: [{ label: "30 secs", minSeconds: 30, maxSeconds: 30 }]
  },
  {
    text: "Microwave on high for 1 min.",
    expected: [{ label: "1 min", minSeconds: minute, maxSeconds: minute }]
  },
  {
    text: "Broil for 3 mins per side.",
    expected: [{ label: "3 mins per side", minSeconds: 3 * minute, maxSeconds: 3 * minute }]
  },
  {
    text: "Marinate for 2 hrs, refrigerated.",
    expected: [{ label: "2 hrs", minSeconds: 2 * hour, maxSeconds: 2 * hour }]
  },
  {
    text: "Rest the roast 1 hr before carving.",
    expected: [{ label: "1 hr", minSeconds: hour, maxSeconds: hour }]
  },
  {
    text: "Cook the lentils for 18-22 min.",
    expected: [{ label: "18-22 min", minSeconds: 18 * minute, maxSeconds: 22 * minute }]
  },
  {
    text: "Fry in batches for 2 to 3 minutes each.",
    expected: [{ label: "2 to 3 minutes", minSeconds: 2 * minute, maxSeconds: 3 * minute }]
  },
  {
    text: "Reduce the sauce for 1/2 hour.",
    expected: [{ label: "1/2 hour", minSeconds: 30 * minute, maxSeconds: 30 * minute }]
  },
  {
    text: "Let the glaze stand ½ hour before using.",
    expected: [{ label: "½ hour", minSeconds: 30 * minute, maxSeconds: 30 * minute }]
  },
  {
    text: "Bake the base 8 minutes to set.",
    expected: [{ label: "8 minutes", minSeconds: 8 * minute, maxSeconds: 8 * minute }]
  },
  {
    text: "Cook the chicken until nearly cooked through, 6-8 minutes.",
    expected: [{ label: "6-8 minutes", minSeconds: 6 * minute, maxSeconds: 8 * minute }]
  },
  {
    text: "Melt the butter until brown specks form, 4-6 minutes.",
    expected: [{ label: "4-6 minutes", minSeconds: 4 * minute, maxSeconds: 6 * minute }]
  },
  {
    text: "Let the filling stand for 5 minutes so the flavors settle.",
    expected: [{ label: "5 minutes", minSeconds: 5 * minute, maxSeconds: 5 * minute }]
  },
  {
    text: "Simmer 2-3 minutes, then rest 5 minutes.",
    expected: [
      { label: "2-3 minutes", minSeconds: 2 * minute, maxSeconds: 3 * minute },
      { label: "5 minutes", minSeconds: 5 * minute, maxSeconds: 5 * minute }
    ]
  },
  {
    text: "Pressure cook for 12 minutes, then natural-release 10 minutes.",
    expected: [
      { label: "12 minutes", minSeconds: 12 * minute, maxSeconds: 12 * minute },
      { label: "10 minutes", minSeconds: 10 * minute, maxSeconds: 10 * minute }
    ]
  },
  {
    text: "Toast until fragrant, about 30 seconds to 1 minute.",
    expected: [{ label: "about 30 seconds", minSeconds: 30, maxSeconds: 30 }]
  },
  { text: "Heat the oven to 350 F and line a pan.", expected: [] },
  { text: "Bake at 350°F until the center springs back.", expected: [] },
  { text: "Set the oven to 180 C.", expected: [] },
  { text: "Add 2 cups flour to the bowl.", expected: [] },
  { text: "Use 1/2 cup milk if the batter is dry.", expected: [] },
  { text: "Step 3 is where the sauce comes together.", expected: [] },
  { text: "Serve on July 4 with extra berries.", expected: [] },
  { text: "Make the dough on 2026-07-04 if preparing ahead.", expected: [] },
  { text: "Refrigerate overnight.", expected: [] },
  { text: "Bake until golden and bubbling.", expected: [] },
  { text: "Cook until the onions are soft.", expected: [] },
  { text: "Meet back at 5 pm to finish dinner.", expected: [] },
  { text: "Start the slow cooker at 7:30 am.", expected: [] },
  { text: "Buy 5-minute oats for the crumble.", expected: [] },
  { text: "Use 8-inch pans for taller bars.", expected: [] },
  { text: "Slice into 12 bars.", expected: [] },
  { text: "Add another 2 tablespoons oil if the pan is dry.", expected: [] },
  { text: "The sauce should reach 165 F before serving.", expected: [] },
  { text: "Cool to room temperature.", expected: [] },
  { text: "Fold until no streaks remain.", expected: [] },
  { text: "Serve immediately.", expected: [] },
  { text: "Season to taste.", expected: [] },
  { text: "Use a 9 by 13 inch baking dish.", expected: [] },
  { text: "Bring 3 quarts water to a boil.", expected: [] },
  { text: "Brush with 2 Tbsp melted butter.", expected: [] },
  { text: "Bake at 425 degrees until crisp.", expected: [] },
  { text: "Cook over medium-high heat.", expected: [] },
  { text: "Pour sauce over 4 chicken thighs.", expected: [] },
  { text: "Let guests arrive around 6.", expected: [] },
  { text: "Move to rack number 2 in the oven.", expected: [] },
  { text: "Leave space for about 20 cookies.", expected: [] }
];

describe("parseStepDurations", () => {
  it("matches the labeled duration corpus with no false timers", () => {
    for (const { text, expected } of durationCorpus) {
      expect(parseStepDurations(text), text).toEqual(expected);
    }
  });

  it("finds every explicit timer in the starter recipes", () => {
    const timersByRecipe = SAMPLE_RECIPES.map((sample) =>
      sample.recipe.steps.flatMap((step) => parseStepDurations(step.text).map((duration) => duration.label))
    );

    expect(timersByRecipe).toEqual([
      ["about 1 minute", "1 minute", "6-8 minutes", "3-4 minutes", "2-3 minutes"],
      ["4-6 minutes", "8 minutes", "25-30 minutes", "at least 30 minutes"],
      ["about 1 minute", "5 minutes"]
    ]);
  });

  it("documents the labeled corpus size", () => {
    expect(durationCorpus).toHaveLength(66);
  });
});
