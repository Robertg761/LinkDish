import { ONBOARDING_STORAGE_KEY } from "../src/features/onboarding/onboarding-routes";

import { expect, test, toasts } from "./fixtures";

test.describe("first visit", () => {
  test.use({ onboardingSeen: false });

  test("welcomes a new cook once, over a cookbook of starter recipes", async ({ page }) => {
    await page.goto("/");

    const welcome = page.getByTestId("first-run-onboarding");
    await expect(
      welcome.getByRole("heading", { name: "Save recipes from anywhere" })
    ).toBeVisible();
    await welcome.getByRole("button", { name: "Skip" }).click();
    await expect(welcome).toBeHidden();
    // What keeps it away next time (the sheet itself only appears after a short delay, so a
    // reload alone can't prove it stays gone).
    expect(
      await page.evaluate((key) => window.localStorage.getItem(key), ONBOARDING_STORAGE_KEY)
    ).toBe("true");

    const main = page.getByRole("main");
    await expect(main.getByText("3 starter recipes")).toBeVisible();
    await expect(
      main.getByRole("link", { name: /Ginger-Sesame Chicken Rice Skillet/u })
    ).toBeVisible();

    await page.reload();
    await expect(main.getByText("3 starter recipes")).toBeVisible();
    await expect(welcome).toBeHidden();
  });
});

test("opens a starter recipe, deletes it and undoes the delete", async ({ page }) => {
  await page.goto("/");
  const main = page.getByRole("main");
  await main
    .getByRole("link", { name: /Crisp Cucumber Chickpea Pitas/u })
    .first()
    .click();

  await expect(
    main.getByRole("heading", { level: 1, name: "Crisp Cucumber Chickpea Pitas" })
  ).toBeVisible();
  await expect(
    main.getByRole("region", { name: "Ingredients" }).getByRole("checkbox").first()
  ).toBeVisible();

  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Delete recipe" }).click();

  await expect(page).toHaveURL("/");
  await expect(main.getByText("2 starter recipes")).toBeVisible();
  await expect(main.getByRole("link", { name: /Crisp Cucumber Chickpea Pitas/u })).toHaveCount(0);

  await toasts(page).getByRole("button", { name: "Undo" }).click();
  await expect(main.getByText("3 starter recipes")).toBeVisible();
  await expect(
    main.getByRole("link", { name: /Crisp Cucumber Chickpea Pitas/u }).first()
  ).toBeVisible();
});
