export interface DomainAdapter {
  key: string;
  hostnames: string[];
  recipePathPatterns: RegExp[];
  articlePathPatterns: RegExp[];
  selectors: {
    title: string[];
    ingredients: string[];
    steps: string[];
    nutrition: string[];
    recipeContainers: string[];
  };
  blockSignals: RegExp[];
}

const sharedRecipeSelectors = {
  title: [
    "h1",
    ".wprm-recipe-name",
    ".mv-create-title-primary",
    ".tasty-recipes-title",
    ".recipe-title"
  ],
  ingredients: [
    ".wprm-recipe-ingredient",
    ".mv-create-ingredients li",
    ".tasty-recipes-ingredients li",
    ".recipe-ingredients li",
    "[itemprop='recipeIngredient']"
  ],
  steps: [
    ".wprm-recipe-instruction-text",
    ".mv-create-instructions li",
    ".tasty-recipes-instructions li",
    ".recipe-instructions li",
    "[itemprop='recipeInstructions']"
  ],
  nutrition: [
    ".wprm-nutrition-label",
    ".mv-create-nutrition-box",
    ".tasty-recipes-nutrition",
    ".nutrition"
  ],
  recipeContainers: [
    ".wprm-recipe-container",
    ".mv-create-recipe",
    ".tasty-recipes",
    ".recipe-card",
    "[itemtype*='Recipe']"
  ]
} as const;

const buildAdapter = (
  key: string,
  hostnames: string[],
  options?: {
    recipePathPatterns?: RegExp[];
    articlePathPatterns?: RegExp[];
    selectors?: Partial<DomainAdapter["selectors"]>;
    blockSignals?: RegExp[];
  }
): DomainAdapter => ({
  key,
  hostnames,
  recipePathPatterns: options?.recipePathPatterns ?? [/\/recipe\//i, /\/recipes\//i],
  articlePathPatterns: options?.articlePathPatterns ?? [
    /\/article\//i,
    /\/story\//i,
    /\/how-to\//i
  ],
  selectors: {
    title: [...sharedRecipeSelectors.title, ...(options?.selectors?.title ?? [])],
    ingredients: [...sharedRecipeSelectors.ingredients, ...(options?.selectors?.ingredients ?? [])],
    steps: [...sharedRecipeSelectors.steps, ...(options?.selectors?.steps ?? [])],
    nutrition: [...sharedRecipeSelectors.nutrition, ...(options?.selectors?.nutrition ?? [])],
    recipeContainers: [
      ...sharedRecipeSelectors.recipeContainers,
      ...(options?.selectors?.recipeContainers ?? [])
    ]
  },
  blockSignals: options?.blockSignals ?? [/captcha/i, /attention required/i, /cf-chl/i]
});

export const domainAdapters: DomainAdapter[] = [
  buildAdapter("allrecipes", ["allrecipes.com"], {
    recipePathPatterns: [/\/recipe\//i],
    articlePathPatterns: [/\/article\//i]
  }),
  buildAdapter("simplyrecipes", ["simplyrecipes.com"], {
    selectors: {
      ingredients: [".structured-project__steps li", ".structured-ingredients li"],
      steps: [".structured-project__steps li", ".comp.recipe__steps li"]
    }
  }),
  buildAdapter("seriouseats", ["seriouseats.com"], {
    selectors: {
      ingredients: [
        ".structured-ingredients__list li",
        "[data-testid='structured-ingredients'] li"
      ],
      steps: [".comp.recipe__steps li", "[data-testid='recipe-method'] li"]
    }
  }),
  buildAdapter("ambitiouskitchen", ["ambitiouskitchen.com"]),
  buildAdapter("onceuponachef", ["onceuponachef.com"]),
  buildAdapter("acouplecooks", ["acouplecooks.com"]),
  buildAdapter("spendwithpennies", ["spendwithpennies.com"]),
  buildAdapter("tastesbetterfromscratch", ["tastesbetterfromscratch.com"]),
  buildAdapter("eatingwell", ["eatingwell.com"], {
    recipePathPatterns: [/\/recipe\//i],
    articlePathPatterns: [/\/article\//i]
  }),
  buildAdapter("themediterraneandish", ["themediterraneandish.com"]),
  buildAdapter("bonappetit", ["bonappetit.com"], {
    articlePathPatterns: [/\/story\//i]
  }),
  buildAdapter("foodandwine", ["foodandwine.com"], {
    articlePathPatterns: [/\/cooking-techniques\//i, /\/how-to\//i]
  }),
  buildAdapter("thekitchn", ["thekitchn.com"], {
    articlePathPatterns: [/\/how-to-/i]
  })
];

export const getDomainAdapter = (hostname: string): DomainAdapter | null =>
  domainAdapters.find((adapter) =>
    adapter.hostnames.some(
      (candidate) => hostname === candidate || hostname.endsWith(`.${candidate}`)
    )
  ) ?? null;
