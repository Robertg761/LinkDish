import { expect, test, toasts } from "./fixtures";

const RECIPE = "Ginger-Sesame Chicken Rice Skillet";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page
    .getByRole("main")
    .getByRole("link", { name: new RegExp(RECIPE, "u") })
    .first()
    .click();
  await expect(page.getByRole("heading", { level: 1, name: RECIPE })).toBeVisible();
});

test("adds a recipe's groceries to the shopping list and ticks one off", async ({ page }) => {
  await page.getByRole("button", { name: "Add to shopping list" }).click();

  const sheet = page.getByRole("dialog", { name: "Add ingredients" });
  const add = sheet.getByRole("button", { name: /^Add \d+ items?$/u });
  const count = Number((await add.textContent())?.match(/\d+/u)?.[0]);
  expect(count).toBeGreaterThan(1);
  await add.click();
  await expect(sheet).toBeHidden();

  await toasts(page).getByRole("button", { name: "View list" }).click();
  await expect(page).toHaveURL("/shopping");

  const main = page.getByRole("main");
  await expect(main.getByText(`${count} to buy`)).toBeVisible();
  const items = main.getByRole("checkbox");
  await expect(items).toHaveCount(count);

  await items.first().check();
  await expect(main.getByText(`${count - 1} to buy`)).toBeVisible();

  await page.reload();
  await expect(main.getByText(`${count - 1} to buy`)).toBeVisible();
});

test("plans a recipe for tonight's dinner", async ({ page }) => {
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Add to meal plan…" }).click();

  const sheet = page.getByRole("dialog", { name: "Add to your plan" });
  await sheet.getByRole("radio", { name: "Dinner" }).check();
  await sheet.getByRole("button", { name: "Add to plan" }).click();
  await expect(sheet).toBeHidden();

  await toasts(page).getByRole("button", { name: "View plan" }).click();
  await expect(page).toHaveURL(/\/plan(?:\?|$)/u);

  const today = page
    .getByRole("main")
    .getByRole("listitem")
    .filter({ has: page.getByRole("heading", { name: /^Today/u }) });
  await expect(today.getByText("Dinner")).toBeVisible();
  await expect(today.getByRole("link", { name: RECIPE })).toBeVisible();
});
