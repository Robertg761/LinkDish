import { E2E_API_ORIGIN } from "./api-origin";
import { expect, test, toasts } from "./fixtures";
import { extractSuccess, weeknightRice } from "./recipes";

import type { ApiMock } from "./fixtures";
import type { Page } from "@playwright/test";

const PHOTO_PATH = "/image/photos/0123456789abcdef0123456789abcdef.webp";
/** A real 1x1 PNG: the page decodes and re-encodes it on a canvas before it is sent. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

const signIn = async (page: Page, api: ApiMock) => {
  await page.addInitScript(() => {
    window.sessionStorage.setItem("linkdish:web:session-token:v1", "session-token");
  });
  api.on("GET", "/auth/config", () => ({
    json: { authMode: "legacy_email_code", clerkEnabled: false, emailCodeEnabled: true }
  }));
  api.on("GET", "/auth/session", () => ({
    json: {
      authenticated: true,
      expiresAt: "2030-01-01T00:00:00.000Z",
      user: { email: "cook@example.com", id: "user_cook" }
    }
  }));
  api.on("GET", "/billing/usage", () => ({
    json: { billingEnabled: false, plan: null, quota: null }
  }));
  api.on("GET", "/household", () => ({ json: { household: null } }));
  api.on("GET", "/household/recipes", () => ({ json: { recipes: [] } }));
  api.on("GET", "/library/changes", () => ({
    json: { changes: [], cursor: "0", hasMore: false }
  }));
  api.on("POST", "/library/changes", (call) => ({
    json: {
      accepted: (call.body as { changes: Array<{ id: string; kind: string }> }).changes.map(
        ({ id, kind }) => ({ id, kind })
      ),
      newer: [],
      rejected: []
    }
  }));
};

/** The picture the cloud cookbook was last sent for the recipe titled `title`, if any. */
const syncedPicture = (api: ApiMock, title: string): string | undefined =>
  api
    .callsTo("POST", "/library/changes")
    .flatMap(
      (call) =>
        (
          call.body as {
            changes: Array<{ recipe?: { recipe?: { image?: { url: string }; title?: string } } }>;
          }
        ).changes
    )
    .map((change) => change.recipe?.recipe)
    .filter((recipe) => recipe?.title === title)
    .at(-1)?.image?.url;

const openRecipe = async (page: Page, title: string) => {
  await page.goto("/");
  await page
    .getByRole("main")
    .getByRole("region", { name: "Recipes", exact: true })
    .getByRole("link", { name: new RegExp(title, "u") })
    .first()
    .click();
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
};

const openEditor = async (page: Page) => {
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Edit recipe" }).click();
  return page.getByRole("dialog", { name: "Edit recipe" });
};

test("replaces a recipe's picture and renames it, and both survive a reload", async ({
  api,
  page
}) => {
  await signIn(page, api);
  api.on("POST", "/image/photos", () => ({
    status: 201,
    json: { height: 1, path: PHOTO_PATH, width: 1 }
  }));

  api.on("POST", "/extract", () => ({ json: extractSuccess(weeknightRice) }));

  await page.goto("/import");
  await page.getByRole("textbox", { name: "Recipe link" }).fill(weeknightRice.sourceUrl);
  await page.getByRole("button", { name: "Get the recipe" }).click();
  await page.getByRole("button", { name: "Save to cookbook" }).click();
  await expect(page.getByRole("main").getByText("Saved to your cookbook")).toBeVisible();
  await openRecipe(page, weeknightRice.title);

  const editor = await openEditor(page);

  await editor.getByLabel("Choose a picture").setInputFiles({
    buffer: PNG,
    mimeType: "image/png",
    name: "dinner.png"
  });
  await expect(editor.getByAltText("Your new recipe picture")).toBeVisible();
  expect(api.callsTo("POST", "/image/photos")).toHaveLength(0);

  await editor.getByLabel("Title").fill("Thursday Rice");

  const photoOnPage = () =>
    page.waitForRequest(
      (request) =>
        new URL(request.url()).pathname === "/image" && request.url().includes("image%2Fphotos")
    );
  const shown = photoOnPage();
  await editor.getByRole("button", { name: "Save changes" }).click();
  await expect(toasts(page).getByText("Recipe updated.")).toBeVisible();
  await shown;

  const [upload] = api.callsTo("POST", "/image/photos");
  expect((upload?.body as { dataUrl: string }).dataUrl).toMatch(/^data:image\/jpeg;base64,/u);
  await expect(page.getByRole("heading", { level: 1, name: "Thursday Rice" })).toBeVisible();

  // Other devices get it through the cloud cookbook, as an ordinary https picture.
  await expect
    .poll(() => syncedPicture(api, "Thursday Rice"))
    .toBe(`${E2E_API_ORIGIN}${PHOTO_PATH}`);

  const shownAgain = photoOnPage();
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Thursday Rice" })).toBeVisible();
  await shownAgain;
});

test("a signed-out cook can remove a picture but is told why they can't add one", async ({
  page
}) => {
  await openRecipe(page, "Ginger-Sesame Chicken Rice Skillet");
  const editor = await openEditor(page);

  await expect(editor.getByText("Sign in to use your own picture.")).toBeVisible();
  await expect(editor.getByLabel("Choose a picture")).toHaveCount(0);
});
