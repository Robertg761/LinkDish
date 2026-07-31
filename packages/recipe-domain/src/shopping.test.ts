import { describe, expect, it } from "vitest";

import { shoppingItemSchema } from "./index";

describe("shoppingItemSchema", () => {
  it("round-trips a household shopping item", () => {
    const item = {
      id: "item_1",
      text: "olive oil",
      qty: {
        min: 1,
        max: 2
      },
      unit: "bottle",
      recipeId: "recipe_1",
      recipeTitle: "Lemon Pasta",
      section: "Pantry",
      addedBy: "user_1",
      checked: true,
      checkedBy: "user_2",
      updatedAt: "2026-07-04T12:00:00.000Z"
    };

    expect(shoppingItemSchema.parse(item)).toEqual(item);
  });

  it("accepts nullable optional recipe metadata", () => {
    const parsed = shoppingItemSchema.parse({
      id: "item_2",
      text: "salt",
      qty: null,
      unit: null,
      recipeId: null,
      recipeTitle: null,
      section: null,
      addedBy: "user_1",
      checked: false,
      checkedBy: null,
      updatedAt: "2026-07-04T12:00:00.000Z"
    });

    expect(parsed.recipeId).toBeNull();
    expect(parsed.checked).toBe(false);
  });

  it("rejects overlong item text and inverted quantity ranges", () => {
    expect(
      shoppingItemSchema.safeParse({
        id: "item_3",
        text: "x".repeat(201),
        addedBy: "user_1",
        checked: false,
        updatedAt: "2026-07-04T12:00:00.000Z"
      }).success
    ).toBe(false);

    expect(
      shoppingItemSchema.safeParse({
        id: "item_4",
        text: "eggs",
        qty: {
          min: 12,
          max: 6
        },
        addedBy: "user_1",
        checked: false,
        updatedAt: "2026-07-04T12:00:00.000Z"
      }).success
    ).toBe(false);
  });
});
