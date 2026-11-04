import { expect, test, toasts } from "./fixtures";

const RECIPE = "Ginger-Sesame Chicken Rice Skillet";

test.beforeEach(async ({ page }) => {
  // Midday, so "today" in the plan sheet and on the plan page can't straddle midnight.
  await page.clock.setFixedTime(new Date("2026-10-14T12:00:00Z"));
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

test("keeps a tick when the page reloads the moment it's tapped", async ({ page }) => {
  await page.getByRole("button", { name: "Add to shopping list" }).click();

  const sheet = page.getByRole("dialog", { name: "Add ingredients" });
  const add = sheet.getByRole("button", { name: /^Add \d+ items?$/u });
  const count = Number((await add.textContent())?.match(/\d+/u)?.[0]);
  await add.click();
  await expect(sheet).toBeHidden();
  await toasts(page).getByRole("button", { name: "View list" }).click();

  const main = page.getByRole("main");
  await expect(main.getByText(`${count} to buy`)).toBeVisible();

  // Phone speed, with the reload in the tap's own task: the write to IndexedDB can't finish.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 6 });
  const reloaded = page.waitForEvent("load");
  await page
    .evaluate(() => {
      document.querySelector<HTMLElement>('[role="checkbox"]')?.click();
      location.reload();
    })
    .catch(() => undefined); // The reload can tear down the evaluation before it answers.
  await reloaded;

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
