import { createLinkDishBackup, SAMPLE_RECIPES } from "@linkdish/recipe-domain";
import { describe, expect, it } from "vitest";

import { WEB_BACKUP_EXTRAS_KEY } from "./backup-format";
import { classifyRecipeJson, parseImportFile } from "./import-sources";
import { isSyntheticImportUrl } from "./synthetic-url";
import {
  buildPaprikaExport,
  buildZip,
  compressBytes,
  jsonBytes,
  melaRecipe,
  paprikaRecipe,
  utf8Bytes
} from "./testing/zip-fixtures";

import type { Recipe } from "@linkdish/recipe-domain";

const skillet = SAMPLE_RECIPES[0].recipe as Recipe;
const TINY_JPEG_BASE64 = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDA==";

const parse = (name: string, bytes: Uint8Array) => parseImportFile({ name, bytes });

describe("parseImportFile", () => {
  it("reads a Paprika export (gzip entries inside a deflated ZIP) with personal data", async () => {
    const zip = await buildPaprikaExport(
      [
        paprikaRecipe({ photo_data: TINY_JPEG_BASE64 }),
        paprikaRecipe({
          uid: "no-link",
          name: "Grandma's Shortbread",
          source_url: "",
          source: "",
          ingredients: "2 cups flour\n1 cup butter\n1/2 cup sugar",
          directions: "Rub together.\nPress into a tin.\nBake at 325°F for 40 minutes.",
          on_favorites: 0,
          rating: 0,
          categories: []
        })
      ],
      { method: "deflate" }
    );

    const parsed = await parse("My Recipes.paprikarecipes", zip);

    expect(parsed.source).toBe("paprika");
    expect(parsed.candidates).toHaveLength(2);
    expect(parsed.photosSkipped).toBe(1);

    const [soup, shortbread] = parsed.candidates;
    expect(soup).toMatchObject({
      sourceUrl: "https://www.seriouseats.com/weeknight-tomato-soup",
      sourceUrlSynthetic: false,
      favorite: true,
      rating: 4,
      tags: ["Soup", "Weeknight"],
      notes: "Add a pinch of sugar if the tomatoes are sharp.",
      createdAt: "2024-02-03T18:22:11.000Z"
    });
    expect(soup?.recipe.title).toBe("Weeknight Tomato Soup");
    expect(soup?.recipe.ingredients).toHaveLength(4);
    expect(soup?.recipe.steps).toHaveLength(3);

    expect(shortbread?.sourceUrlSynthetic).toBe(true);
    expect(isSyntheticImportUrl(shortbread?.sourceUrl)).toBe(true);
    expect(shortbread?.sourceUrl).toMatch(
      /^https:\/\/linkdish\.app\/imports\/paprika\/grandma-s-shortbread-[0-9a-f]{8}$/u
    );
    expect(shortbread?.favorite).toBeUndefined();
  });

  it("also reads stored ZIP entries and a single gzip .paprikarecipe", async () => {
    const stored = await buildPaprikaExport([paprikaRecipe()], { method: "store" });
    expect((await parse("export.paprikarecipes", stored)).candidates).toHaveLength(1);

    const single = await compressBytes(jsonBytes(paprikaRecipe()), "gzip");
    const parsed = await parse("Soup.paprikarecipe", single);
    expect(parsed.source).toBe("paprika");
    expect(parsed.candidates[0]?.recipe.title).toBe("Weeknight Tomato Soup");
  });

  it("skips recipes LinkDish can't use and explains why", async () => {
    const zip = await buildPaprikaExport([
      paprikaRecipe(),
      paprikaRecipe({ uid: "x", name: "Just a note", directions: "" })
    ]);
    const parsed = await parse("export.paprikarecipes", zip);

    expect(parsed.candidates).toHaveLength(1);
    expect(parsed.unreadable).toBe(1);
    expect(parsed.warnings).toContain("“Just a note” was skipped because it has no steps.");
  });

  it("counts entries that aren't valid JSON as unreadable", async () => {
    const zip = await buildZip([
      { name: "Good.paprikarecipe", data: await compressBytes(jsonBytes(paprikaRecipe()), "gzip") },
      { name: "Broken.paprikarecipe", data: utf8Bytes("{not json") },
      { name: "__MACOSX/._Good.paprikarecipe", data: utf8Bytes("junk") }
    ]);
    const parsed = await parse("export.paprikarecipes", zip);

    expect(parsed.candidates).toHaveLength(1);
    expect(parsed.unreadable).toBe(1);
    expect(parsed.warnings).toContain("“Broken” couldn't be read, so it was skipped.");
  });

  it("reads Mela archives and single .melarecipe files", async () => {
    const archive = await buildZip([
      {
        name: "Pancakes.melarecipe",
        data: jsonBytes(melaRecipe({ images: [TINY_JPEG_BASE64] }))
      },
      {
        name: "Salad.melarecipe",
        data: jsonBytes(
          melaRecipe({
            id: "mela-2",
            title: "Herby Salad",
            link: "https://example.com/herby-salad",
            favorite: false
          })
        )
      }
    ]);
    const parsed = await parse("Recipes.melarecipes", archive);

    expect(parsed.source).toBe("mela");
    expect(parsed.candidates.map((candidate) => candidate.recipe.title)).toEqual([
      "Lemon Ricotta Pancakes",
      "Herby Salad"
    ]);
    expect(parsed.candidates[0]).toMatchObject({ favorite: true, tags: ["Breakfast"] });
    expect(parsed.candidates[0]?.recipe.ingredients[0]).toMatchObject({ section: "Batter" });
    expect(parsed.candidates[1]?.sourceUrl).toBe("https://example.com/herby-salad");
    expect(parsed.photosSkipped).toBe(1);

    const single = await parse("Pancakes.melarecipe", jsonBytes(melaRecipe()));
    expect(single.source).toBe("mela");
    expect(single.candidates).toHaveLength(1);
  });

  it("reads schema.org JSON-LD, including several recipes in a @graph", async () => {
    const jsonLd = {
      "@context": "https://schema.org",
      "@graph": [
        { "@type": "WebPage", name: "Recipes" },
        {
          "@type": "Recipe",
          name: "Chili Crisp Noodles",
          url: "https://example.com/noodles",
          recipeIngredient: ["200 g noodles", "2 Tbsp chili crisp"],
          recipeInstructions: [{ "@type": "HowToStep", text: "Cook the noodles." }]
        },
        {
          "@type": ["Recipe"],
          name: "Garlic Butter Rice",
          recipeIngredient: ["1 cup rice", "2 Tbsp butter"],
          recipeInstructions: "Toast the rice in butter.\nSimmer until tender."
        }
      ]
    };
    const parsed = await parse("recipes.json", jsonBytes(jsonLd));

    expect(parsed.source).toBe("schema_org");
    expect(parsed.candidates.map((candidate) => candidate.recipe.title)).toEqual([
      "Chili Crisp Noodles",
      "Garlic Butter Rice"
    ]);
    expect(parsed.candidates[0]?.sourceUrl).toBe("https://example.com/noodles");
    expect(parsed.candidates[1]?.sourceUrl).toMatch(
      /^https:\/\/linkdish\.app\/imports\/schema-org\//u
    );
  });

  it("reads a LinkDish backup with collections, meal plan and web extras", async () => {
    const backup = {
      ...createLinkDishBackup({
        exportedAt: "2026-09-27T10:00:00.000Z",
        recipes: [
          {
            id: "saved-1",
            recipe: skillet,
            meta: {
              favorite: true,
              tags: ["weeknight"],
              rating: 5,
              notes: "Double the sauce.",
              timesCooked: 2,
              cookLog: [{ cookedAt: "2026-09-20T18:00:00.000Z", note: "Great" }],
              createdAt: "2026-09-01T12:00:00.000Z",
              updatedAt: "2026-09-20T18:30:00.000Z",
              sourceUrl: skillet.sourceUrl
            }
          }
        ],
        collections: [{ id: "c1", name: "Weeknights", recipeIds: ["saved-1"] }],
        mealPlan: [{ id: "m1", date: "2026-09-28", slot: "dinner", recipeId: "saved-1" }]
      }),
      [WEB_BACKUP_EXTRAS_KEY]: {
        version: 1,
        recipes: { "saved-1": { preferredServings: 6, lastCookedAt: "2026-09-20T18:00:00.000Z" } },
        collections: { c1: { emoji: "🌙", sortOrder: 3 } },
        mealPlan: { m1: { createdAt: "2026-09-26T09:00:00.000Z" } },
        sourceImages: {
          "saved-1": [
            { dataUrl: `data:image/jpeg;base64,${TINY_JPEG_BASE64}`, mimeType: "image/jpeg" }
          ],
          bogus: [{ dataUrl: "javascript:alert(1)", mimeType: "image/jpeg" }]
        }
      }
    };

    const parsed = await parse("linkdish-backup-2026-09-27.json", jsonBytes(backup));

    expect(parsed.source).toBe("linkdish");
    expect(parsed.exportedAt).toBe("2026-09-27T10:00:00.000Z");
    expect(parsed.candidates[0]).toMatchObject({
      originalId: "saved-1",
      favorite: true,
      tags: ["weeknight"],
      rating: 5,
      notes: "Double the sauce.",
      timesCooked: 2,
      cookLog: [{ cookedAt: "2026-09-20T18:00:00.000Z", note: "Great" }],
      preferredServings: 6,
      lastCookedAt: "2026-09-20T18:00:00.000Z"
    });
    expect(parsed.candidates[0]?.sourceImages).toHaveLength(1);
    expect(parsed.scannedPhotoRecipes).toBe(1);
    expect(parsed.collections).toEqual([
      { id: "c1", name: "Weeknights", recipeIds: ["saved-1"], emoji: "🌙", sortOrder: 3 }
    ]);
    expect(parsed.mealPlan[0]).toMatchObject({ id: "m1", createdAt: "2026-09-26T09:00:00.000Z" });
    expect(parsed.warnings).toEqual(["1 extra detail was damaged and left out."]);
  });

  it("recognizes formats from the content, not the file name", () => {
    expect(classifyRecipeJson({ format: "linkdish-backup" })).toBe("linkdish");
    expect(classifyRecipeJson(paprikaRecipe())).toBe("paprika");
    expect(classifyRecipeJson(melaRecipe())).toBe("mela");
    expect(classifyRecipeJson({ "@type": "Recipe", name: "x" })).toBe("schema_org");
    expect(classifyRecipeJson({ "@type": "Person" })).toBeNull();
    expect(classifyRecipeJson({ hello: "world" })).toBeNull();
  });

  it("gives friendly errors for empty, unsupported, damaged and newer files", async () => {
    await expect(parse("empty.json", new Uint8Array())).rejects.toMatchObject({
      code: "empty_file"
    });
    await expect(parse("notes.txt", utf8Bytes("just some text"))).rejects.toMatchObject({
      code: "unsupported_file"
    });
    await expect(
      parse("backup.json", utf8Bytes('{"format": "linkdish-backup",'))
    ).rejects.toMatchObject({ code: "corrupt_file" });
    await expect(parse("data.json", jsonBytes({ hello: "world" }))).rejects.toMatchObject({
      code: "unsupported_file"
    });
    await expect(
      parse(
        "backup.json",
        jsonBytes({ format: "linkdish-backup", version: 9, exportedAt: "2026-09-27T10:00:00.000Z" })
      )
    ).rejects.toMatchObject({
      code: "newer_backup",
      message: expect.stringMatching(/newer version/u) as string
    });
    await expect(
      parse("backup.json", jsonBytes({ format: "linkdish-backup", version: 1, recipes: "nope" }))
    ).rejects.toMatchObject({
      code: "corrupt_file",
      message:
        "This backup file is damaged, so it can't be restored. Try downloading a fresh backup."
    });
    await expect(
      parse("broken.paprikarecipes", utf8Bytes("PK\u0003\u0004 truncated"))
    ).rejects.toMatchObject({
      code: "corrupt_file"
    });

    const noUsableRecipes = await buildPaprikaExport([paprikaRecipe({ ingredients: "" })]);
    await expect(parse("export.paprikarecipes", noUsableRecipes)).rejects.toMatchObject({
      code: "no_recipes",
      message: expect.stringMatching(/none had the ingredients and steps/u) as string
    });
  });

  it("reports progress while unpacking archives", async () => {
    const zip = await buildPaprikaExport([
      paprikaRecipe(),
      paprikaRecipe({ uid: "2", name: "Second Soup" }),
      paprikaRecipe({ uid: "3", name: "Third Soup" })
    ]);
    const progress: Array<[number, number]> = [];

    await parseImportFile(
      { name: "export.paprikarecipes", bytes: zip },
      { onProgress: ({ done, total }) => progress.push([done, total]) }
    );

    expect(progress).toEqual([
      [0, 3],
      [1, 3],
      [2, 3],
      [3, 3]
    ]);
  });
});
