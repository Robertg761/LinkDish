import { expect, test } from "./fixtures";
import { extractFailure, extractSuccess, weeknightRice } from "./recipes";

test("imports a recipe from a link and keeps it in the cookbook", async ({ page, api }) => {
  api.on("POST", "/extract", () => ({ json: extractSuccess(weeknightRice) }));

  await page.goto("/import");
  await page.getByRole("textbox", { name: "Recipe link" }).fill(weeknightRice.sourceUrl);
  await page.getByRole("button", { name: "Get the recipe" }).click();

  const main = page.getByRole("main");
  await expect(main.getByRole("heading", { level: 1, name: weeknightRice.title })).toBeVisible();
  await expect(main.getByRole("checkbox", { name: "1 cup jasmine rice" })).toBeVisible();
  expect(api.callsTo("POST", "/extract")).toEqual([
    expect.objectContaining({ body: expect.objectContaining({ url: weeknightRice.sourceUrl }) })
  ]);

  await page.getByRole("button", { name: "Save to cookbook" }).click();
  await expect(main.getByText("Saved to your cookbook")).toBeVisible();

  // A fresh load reads the cookbook back from IndexedDB.
  await page.goto("/");
  await main.getByRole("link", { name: weeknightRice.title }).first().click();

  await expect(page).toHaveURL(/\/recipes\/[a-f0-9]+$/u);
  await expect(main.getByRole("heading", { level: 1, name: weeknightRice.title })).toBeVisible();
  await expect(main.getByText("Simmer, covered, for 15 minutes.")).toBeVisible();
});

test("offers pasted text when a site blocks the link", async ({ page, api }) => {
  const soup = { ...weeknightRice, title: "Pantry Lentil Soup" };
  api.on("POST", "/extract", ({ body }) =>
    (body as { url?: string } | null)?.url
      ? { json: extractFailure("source_blocked") }
      : { json: extractSuccess(soup) }
  );

  await page.goto("/import");
  await page.getByRole("textbox", { name: "Recipe link" }).fill("https://blocked.example.com/soup");
  await page.getByRole("button", { name: "Get the recipe" }).click();

  const main = page.getByRole("main");
  await expect(main.getByText("That site kept its door shut")).toBeVisible();
  await main.getByRole("button", { name: "Paste the recipe text" }).click();

  const text =
    "Lentil soup\n\nIngredients\n1 cup red lentils\n4 cups stock\n\nSteps\nSimmer for 20 minutes.";
  await page.getByRole("textbox", { name: "Recipe text" }).fill(text);
  await page.getByRole("button", { name: "Get the recipe" }).click();

  await expect(main.getByRole("heading", { level: 1, name: soup.title })).toBeVisible();
  expect(api.callsTo("POST", "/extract").map((call) => call.body)).toEqual([
    expect.objectContaining({ url: "https://blocked.example.com/soup" }),
    expect.objectContaining({ text })
  ]);
});
