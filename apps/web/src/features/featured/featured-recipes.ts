import type { FeaturedRecipe } from "./types";

export const featuredRecipes = [
  {
    slug: "classic-sandwich-bread",
    sourceUrl: "https://www.kingarthurbaking.com/recipes/classic-sandwich-bread-recipe",
    recipe: {
      title: "Classic Sandwich Bread",
      sourceUrl: "https://www.kingarthurbaking.com/recipes/classic-sandwich-bread-recipe",
      sourceType: "recipe-webpage",
      image: {
        url: "https://www.kingarthurbaking.com/sites/default/files/2026-02/Classic-Sandwich-Bread-12.jpg",
        source: "jsonld"
      },
      ingredients: [
        {
          text: "3 cups (360g) King Arthur Unbleached All-Purpose Flour",
          section: null
        },
        {
          text: "1/2 cup (113g) milk, (skim, 1%, 2% or whole, your choice)*",
          section: null
        },
        {
          text: '1/2 to 2/3 cup (113g to 152g) hot water, enough to make a soft, smooth dough* (see "tips," below)',
          section: null
        },
        {
          text: "4 tablespoons (57g) melted butter or 1/4 cup (50g) vegetable oil",
          section: null
        },
        {
          text: "2 tablespoons (25g) granulated sugar",
          section: null
        },
        {
          text: "1 1/4 teaspoons (8g) table salt",
          section: null
        },
        {
          text: "2 teaspoons instant yeast",
          section: null
        }
      ],
      steps: [
        {
          index: 1,
          text: "Weigh your flour; or measure it by gently spooning it into a cup, then sweeping off any excess."
        },
        {
          index: 2,
          text: "In a large bowl, combine all of the ingredients. Mix and knead everything together — by hand, mixer, or bread machine set on the dough cycle — until you've made a smooth dough. If you're kneading in a stand mixer, it should take 5 to 7 minutes at medium-low speed, and the dough should barely clean the sides of the bowl, perhaps sticking a bit at the bottom. In a bread machine (or by hand), knead the dough for about 6 to 8 minutes, until it forms a smooth ball."
        },
        {
          index: 3,
          text: "Transfer the dough to a lightly greased bowl, cover the bowl, and allow the dough to rise until puffy though not necessarily doubled in bulk, about 1 to 2 hours, depending on the warmth of your kitchen. If you're using a bread machine, allow the machine to complete its cycle, then leave the dough in the machine until it's doubled in bulk, perhaps an additional 30 minutes or so."
        },
        {
          index: 4,
          text: 'Gently deflate the dough and transfer it to a lightly oiled work surface. Shape the dough into an 8" log.'
        },
        {
          index: 5,
          text: 'Place the log in a lightly greased 8 1/2" x 4 1/2" loaf pan, cover the pan loosely with lightly greased plastic wrap, and allow the bread to rise for about 60 minutes, until it\'s domed about 1" above the edge of the pan. A finger pressed into the dough should leave a mark that rebounds slowly. Towards the end of the rise, preheat your oven to 350°F.'
        },
        {
          index: 6,
          text: "Bake the bread for 30 to 35 minutes, until it's light golden brown. Test it for doneness by removing it from the pan and thumping it on the bottom (it should sound hollow), or by measuring its interior temperature with a digital thermometer (it should register 190°F at the center of the loaf)."
        },
        {
          index: 7,
          text: "Remove the bread from the oven, and cool it on a rack before slicing. Store the bread in a plastic bag at room temperature for several days; freeze for longer storage."
        }
      ],
      servings: "16, 1 loaf",
      prepTimeMinutes: 12,
      cookTimeMinutes: 40,
      nutrition: {
        calories: "120 calories",
        protein: "3g",
        carbohydrates: "19g",
        fat: "3g",
        fiber: "1g",
        sugar: "2g",
        sodium: "190mg"
      },
      confidence: {
        score: 0.9500000000000001,
        summary: "Detected Recipe JSON-LD on the page.",
        missingFields: [],
        notes: [],
        fieldProvenance: {
          title: "jsonld",
          ingredients: "jsonld",
          steps: "jsonld",
          servings: "jsonld",
          prepTimeMinutes: "jsonld",
          cookTimeMinutes: "jsonld",
          nutrition: "jsonld"
        }
      }
    },
    extraction: {
      fetchMode: "http",
      provenance: ["jsonld"],
      strategy: "recipe-schema",
      warnings: []
    }
  },
  {
    slug: "pizza-crust",
    sourceUrl: "https://www.kingarthurbaking.com/recipes/pizza-crust-recipe",
    recipe: {
      title: "Pizza Crust",
      sourceUrl: "https://www.kingarthurbaking.com/recipes/pizza-crust-recipe",
      sourceType: "recipe-webpage",
      image: {
        url: "https://www.kingarthurbaking.com/sites/default/files/2026-05/Pizza-Crust-Recipe.jpg",
        source: "jsonld"
      },
      ingredients: [
        {
          text: "2 teaspoons active dry yeast or instant yeast",
          section: null
        },
        {
          text: "7/8 to 1 1/8 cups (198g to 255g) lukewarm water*",
          section: null
        },
        {
          text: "2 tablespoons (25g) olive oil",
          section: null
        },
        {
          text: "3 cups (360g) King Arthur Unbleached All-Purpose Flour",
          section: null
        },
        {
          text: "1 1/4 teaspoons (8g) table salt",
          section: null
        }
      ],
      steps: [
        {
          index: 1,
          text: "If you're using active dry yeast, dissolve it, with a pinch of sugar, in 2 tablespoons of the lukewarm water. Let the yeast and water sit at room temperature for 15 minutes, until the mixture has bubbled and expanded. If you're using instant yeast, you can skip this step."
        },
        {
          index: 2,
          text: "Weigh your flour; or measure it by gently spooning it into a cup, then sweeping off any excess. Combine the dissolved yeast (or the instant yeast) with the remainder of the ingredients. Mix and knead everything together —by hand, mixer or bread machine set on the dough cycle — till you've made a soft, smooth dough. If you're kneading in a stand mixer, it should take 4 to 5 minutes at second speed, and the dough should barely clean the sides of the bowl, perhaps sticking a bit at the bottom. Don't over-knead the dough; it should hold together, but can still look fairly rough on the surface."
        },
        {
          index: 3,
          text: "To make pizza up to 24 hours later, skip to step 5."
        },
        {
          index: 4,
          text: "To make pizza now: Place the dough in a lightly greased bowl, cover the bowl, and allow it to rise till it's very puffy. This will take about an hour using instant yeast, or 90 minutes using active dry. If it takes longer, that's OK; just give it some extra time."
        },
        {
          index: 5,
          text: "To make pizza later: Allow the dough to rise, covered, for 45 minutes at room temperature. Refrigerate the dough for 4 hours (or for up to 24 hours); it will rise slowly as it chills. This step allows you more schedule flexibility; it also develops the crust's flavor. About 2 to 3 hours before you want to serve pizza, remove the dough from the refrigerator."
        },
        {
          index: 6,
          text: 'Decide what size, shape, and thickness of pizza you want to make. This recipe will make one of the following choices:Two 1/2"-thick 14" round pizzas (pictured);Two 3/4"-thick 12" round pizzas;One 3/4" to 1"-thick 13" x 18" rectangular (Sicilian-style) pizza (pictured);One 1 1/2"-thick 9" x 13" rectangular pizza;One 1"-thick 14" round pizza.'
        },
        {
          index: 7,
          text: "Divide the dough in half, for two pizzas; or leave it whole for one pizza."
        },
        {
          index: 8,
          text: "If you're making a rectangular pizza, shape the dough into a rough oval. For a round pizza, shape it into a rough circle. In either case, don't pat it flat; just stretch it briefly into shape. Allow the dough to rest, covered with an overturned bowl or lightly greased plastic wrap, for 15 minutes."
        },
        {
          index: 9,
          text: "Use vegetable oil pan spray to lightly grease the pan(s) of your choice. Drizzle olive oil into the bottom of the pan(s). The pan spray keeps the pizza from sticking; the olive oil gives the crust great flavor and crunch."
        },
        {
          index: 10,
          text: "Place the dough in the prepared pan(s). Press it over the bottom of the pan, stretching it towards the edges. You'll probably get about two-thirds of the way there before the dough starts shrinking back; walk away for 15 minutes. Cover the dough while you're away, so it doesn't dry out."
        },
        {
          index: 11,
          text: "When you come back, you should be able to pat the dough closer to the corners of the pan. Repeat the rest and dough-stretch one more time, if necessary; your goal is to get the dough to fill the pan as fully as possible."
        },
        {
          index: 12,
          text: "Allow the dough to rise, covered, till it's noticeably puffy, about 90 minutes (if it hasn't been refrigerated); or 2 to 2 1/2 hours (if it's been refrigerated). Towards the end of the rising time, preheat the oven to 450°F."
        },
        {
          index: 13,
          text: "Bake the pizza on the lower oven rack till it looks and feels set on top, and is just beginning to brown around the edge of the crust, but is still pale on top. This will take about 8 minutes for thinner crust pizza; about 10 to 12 minutes for medium thickness; and 12 to 14 minutes for thick-crust pizza. If you're baking two pizzas, reverse them in the oven (top to bottom, bottom to top) midway through the baking period."
        },
        {
          index: 14,
          text: "To serve pizza immediately: Remove it from the oven, and arrange your toppings of choice on top. Return to the oven, and bake on the upper oven rack for an additional 10 to 15 minutes, until the crust is nicely browned, both top and bottom, and the cheese is melted. Check it midway through, and move it to the bottom rack if the top is browning too much, or the bottom not enough."
        },
        {
          index: 15,
          text: "To serve pizza up to 2 days later: Remove the untopped, partially baked crust from the oven, cool completely on a rack, wrap in plastic, and store at room temperature. When ready to serve, top and bake in a preheated 450°F oven, adding a couple of minutes to the baking times noted above. Your goal is a pizza whose crust is browned, and whose toppings are hot/melted."
        },
        {
          index: 16,
          text: "Remove the pizza from the oven, and transfer it from the pan to a rack to cool slightly before serving. For easiest serving, cut with a pair of scissors."
        }
      ],
      servings: "12, 1 or 2 standard round pizzas, or 1 large rectangular pizza, about 12 servings",
      prepTimeMinutes: 20,
      cookTimeMinutes: 30,
      nutrition: {
        calories: "130 calories",
        protein: "4g",
        carbohydrates: "22g",
        fat: "2.5g",
        fiber: "1g",
        sugar: "0g",
        sodium: "240mg"
      },
      confidence: {
        score: 0.9500000000000001,
        summary: "Detected Recipe JSON-LD on the page.",
        missingFields: [],
        notes: [],
        fieldProvenance: {
          title: "jsonld",
          ingredients: "jsonld",
          steps: "jsonld",
          servings: "jsonld",
          prepTimeMinutes: "jsonld",
          cookTimeMinutes: "jsonld",
          nutrition: "jsonld"
        }
      }
    },
    extraction: {
      fetchMode: "http",
      provenance: ["jsonld"],
      strategy: "recipe-schema",
      warnings: []
    }
  },
  {
    slug: "classic-chocolate-chip-cookies",
    sourceUrl: "https://www.kingarthurbaking.com/recipes/chocolate-chip-cookies-recipe",
    recipe: {
      title: "Classic Chocolate Chip Cookies",
      sourceUrl: "https://www.kingarthurbaking.com/recipes/chocolate-chip-cookies-recipe",
      sourceType: "recipe-webpage",
      image: {
        url: "https://www.kingarthurbaking.com/sites/default/files/2026-04/Classic-Chocolate-Chip-Cookie-5.jpg",
        source: "jsonld"
      },
      ingredients: [
        {
          text: "2/3 cup (142g) light brown sugar, packed",
          section: null
        },
        {
          text: "2/3 cup (131g) granulated sugar",
          section: null
        },
        {
          text: "8 tablespoons (113g) unsalted butter",
          section: null
        },
        {
          text: "1/2 cup (92g) vegetable shortening",
          section: null
        },
        {
          text: "3/4 teaspoon table salt, (use 1/2 teaspoon salt if you use salted butter)",
          section: null
        },
        {
          text: "2 teaspoons King Arthur Pure Vanilla Extract",
          section: null
        },
        {
          text: "1/4 teaspoon almond extract, optional",
          section: null
        },
        {
          text: "1 teaspoon cider vinegar or white vinegar",
          section: null
        },
        {
          text: "1 teaspoon baking soda",
          section: null
        },
        {
          text: "1 large egg",
          section: null
        },
        {
          text: "2 cups (240g) King Arthur Unbleached All-Purpose Flour",
          section: null
        },
        {
          text: "2 cups (340g) semisweet chocolate chips*",
          section: null
        }
      ],
      steps: [
        {
          index: 1,
          text: "Preheat the oven to 375°F. Lightly grease (or line with parchment) two baking sheets."
        },
        {
          index: 2,
          text: "In a large bowl, combine the sugars, butter, shortening, salt, vanilla and almond extracts, vinegar, and baking soda, beating until smooth and creamy."
        },
        {
          index: 3,
          text: "Beat in the egg, again beating until smooth. Scrape the bottom and sides of the bowl with a spatula to make sure everything is thoroughly combined."
        },
        {
          index: 4,
          text: "Mix in the flour, then the chips."
        },
        {
          index: 5,
          text: 'Use a spoon (or a tablespoon cookie scoop) to scoop 1 1/4" balls of dough onto the prepared baking sheets, leaving 2" between them on all sides; they\'ll spread.'
        },
        {
          index: 6,
          text: "For enticing salty-sweet flavor, sprinkle a touch of sea salt atop the cookies before putting them in the oven, if desired."
        },
        {
          index: 7,
          text: "Bake the cookies for 11 to 12 minutes, until their edges are chestnut brown and their tops are light golden brown, almost blonde."
        },
        {
          index: 8,
          text: "Remove the cookies from the oven, and cool on the pan until they've set enough to move without breaking. Repeat with the remaining dough."
        },
        {
          index: 9,
          text: "Store cookies, well wrapped, at room temperature for up to 5 days; freeze for longer storage."
        }
      ],
      servings: "36, 36 cookies",
      prepTimeMinutes: 12,
      cookTimeMinutes: 12,
      nutrition: {
        calories: "150 calories",
        protein: "1g",
        carbohydrates: "19g",
        fat: "8g",
        fiber: "1g",
        sugar: "13g",
        sodium: "70mg"
      },
      confidence: {
        score: 0.9500000000000001,
        summary: "Detected Recipe JSON-LD on the page.",
        missingFields: [],
        notes: [],
        fieldProvenance: {
          title: "jsonld",
          ingredients: "jsonld",
          steps: "jsonld",
          servings: "jsonld",
          prepTimeMinutes: "jsonld",
          cookTimeMinutes: "jsonld",
          nutrition: "jsonld"
        }
      }
    },
    extraction: {
      fetchMode: "http",
      provenance: ["jsonld"],
      strategy: "recipe-schema",
      warnings: []
    }
  },
  {
    slug: "banana-bread",
    sourceUrl: "https://www.kingarthurbaking.com/recipes/banana-bread-recipe",
    recipe: {
      title: "Banana Bread",
      sourceUrl: "https://www.kingarthurbaking.com/recipes/banana-bread-recipe",
      sourceType: "recipe-webpage",
      image: {
        url: "https://www.kingarthurbaking.com/sites/default/files/recipe_legacy/5-3-large.jpg",
        source: "jsonld"
      },
      ingredients: [
        {
          text: "8 tablespoons (113g) unsalted butter, at cool room temperature",
          section: null
        },
        {
          text: "2/3 cup (142g) light brown sugar or dark brown sugar, packed",
          section: null
        },
        {
          text: "1 teaspoon King Arthur Pure Vanilla Extract",
          section: null
        },
        {
          text: "1 teaspoon ground cinnamon",
          section: null
        },
        {
          text: "1/4 teaspoon ground nutmeg",
          section: null
        },
        {
          text: "1 teaspoon baking soda",
          section: null
        },
        {
          text: "1 teaspoon baking powder",
          section: null
        },
        {
          text: "1 teaspoon table salt",
          section: null
        },
        {
          text: "1 1/2 cups (340g) bananas, mashed",
          section: null
        },
        {
          text: "3 tablespoons (64g) apricot jam or orange marmalade, optional but tasty",
          section: null
        },
        {
          text: "1/4 cup (85g) honey",
          section: null
        },
        {
          text: "2 large eggs",
          section: null
        },
        {
          text: "2 1/4 cups (270g) King Arthur Unbleached All-Purpose Flour",
          section: null
        },
        {
          text: "1/2 cup (57g) chopped walnuts, optional",
          section: null
        }
      ],
      steps: [
        {
          index: 1,
          text: 'Preheat the oven to 325°F. Lightly grease a 9" x 5" loaf pan; or a 12" x 4" tea loaf pan.'
        },
        {
          index: 2,
          text: "In a large bowl or the bowl of a stand mixer fitted with the flat beater attachment, stir together the butter, sugar, vanilla, cinnamon, nutmeg, baking soda, baking powder, and salt. Stir vigorously using a flexible spatula for 2 to 3 minutes if mixing by hand, or mix on medium speed for 1 minute, until smooth."
        },
        {
          index: 3,
          text: "Add the mashed bananas, jam, honey, and eggs, and stir until smooth. (Some lumps of banana are OK; the batter may look slightly curdled at this point.)"
        },
        {
          index: 4,
          text: "Add the flour, then the walnuts, stirring just until smooth."
        },
        {
          index: 5,
          text: "Spoon the batter into the prepared loaf pan, smoothing the top. (A small offset spatula is a helpful tool here.) Let it rest at room temperature for 10 minutes."
        },
        {
          index: 6,
          text: "Bake the bread for 45 minutes, then gently lay a piece of aluminum foil across the top, to prevent over-browning."
        },
        {
          index: 7,
          text: "Bake for an additional 25 minutes (20 minutes if you're baking in a tea loaf pan). Remove the bread from the oven; a long toothpick or thin knife inserted into the center should come out clean, with a few wet crumbs clinging to it (no sign of uncooked batter). If it does, bake the bread an additional 5 minutes, or until it tests done."
        },
        {
          index: 8,
          text: "Allow the bread to cool for 10 minutes in the pan. Remove it from the pan, and cool it completely on a rack."
        }
      ],
      servings: "18, 1 loaf",
      prepTimeMinutes: 20,
      cookTimeMinutes: 70,
      nutrition: {
        calories: "170 calories",
        protein: "3g",
        carbohydrates: "27g",
        fat: "6g",
        fiber: "1g",
        sugar: "14g",
        sodium: "230mg"
      },
      confidence: {
        score: 0.9500000000000001,
        summary: "Detected Recipe JSON-LD on the page.",
        missingFields: [],
        notes: [],
        fieldProvenance: {
          title: "jsonld",
          ingredients: "jsonld",
          steps: "jsonld",
          servings: "jsonld",
          prepTimeMinutes: "jsonld",
          cookTimeMinutes: "jsonld",
          nutrition: "jsonld"
        }
      }
    },
    extraction: {
      fetchMode: "http",
      provenance: ["jsonld"],
      strategy: "recipe-schema",
      warnings: []
    }
  },
  {
    slug: "jo-mamas-spaghetti",
    sourceUrl: "https://www.food.com/recipe/jo-mamas-world-famous-spaghetti-22782",
    recipe: {
      title: "Jo Mama's World Famous Spaghetti",
      sourceUrl: "https://www.food.com/recipe/jo-mamas-world-famous-spaghetti-22782",
      sourceType: "recipe-webpage",
      image: {
        url: "https://img.sndimg.com/food/image/upload/q_92,fl_progressive,w_1200,c_scale/v1/img/recipes/22/78/2/xy39o2sOTtudkgyDgZtv_spaghettisauce.jpg",
        source: "jsonld"
      },
      ingredients: [
        {
          text: "2 lbs Italian sausage, casings removed (mild or hot)",
          section: null
        },
        {
          text: "1 small onion, chopped (optional)",
          section: null
        },
        {
          text: "3 -4 garlic cloves, minced",
          section: null
        },
        {
          text: "1 (28 ounce) can diced tomatoes",
          section: null
        },
        {
          text: "2 (6 ounce) cans tomato paste",
          section: null
        },
        {
          text: "2 (15 ounce) cans tomato sauce",
          section: null
        },
        {
          text: "2 cups water (for a long period of simmering for flavors to meld. If you don't want to simmer it as long, add less)",
          section: null
        },
        {
          text: "3 teaspoons basil",
          section: null
        },
        {
          text: "2 teaspoons dried parsley flakes",
          section: null
        },
        {
          text: "1 1/2 teaspoons brown sugar",
          section: null
        },
        {
          text: "1 teaspoon salt",
          section: null
        },
        {
          text: "1/4-1/2 teaspoon crushed red pepper flakes",
          section: null
        },
        {
          text: "1/4 teaspoon fresh coarse ground black pepper",
          section: null
        },
        {
          text: "1/4 cup red wine (a good Cabernet!)",
          section: null
        },
        {
          text: "1 lb thin spaghetti",
          section: null
        },
        {
          text: "parmesan cheese",
          section: null
        }
      ],
      steps: [
        {
          index: 1,
          text: "In large, heavy stockpot, brown Italian sausage, breaking up as you stir."
        },
        {
          index: 2,
          text: "Add onions and continue to cook, stirring occasionally until onions are softened."
        },
        {
          index: 3,
          text: "Add garlic, tomatoes, tomato paste, tomato sauce and water."
        },
        {
          index: 4,
          text: "Add basil, parsley, brown sugar, salt, crushed red pepper, and black pepper."
        },
        {
          index: 5,
          text: "Stir well and barely bring to a boil."
        },
        {
          index: 6,
          text: "Stir in red wine."
        },
        {
          index: 7,
          text: "Simmer on low, stirring frequently for at least an hour. A longer simmer makes for a better sauce, just be careful not to let it burn!"
        },
        {
          index: 8,
          text: "Cook spaghetti according to package directions."
        },
        {
          index: 9,
          text: "Spoon sauce over drained spaghetti noodles and sprinkle with parmesan cheese."
        }
      ],
      servings: "4 quarts, 10-14 serving(s)",
      prepTimeMinutes: 20,
      cookTimeMinutes: 60,
      nutrition: {
        calories: "555.9",
        protein: "29.8",
        carbohydrates: "50.1",
        fat: "26.3",
        fiber: "3.8",
        sugar: "11.4",
        sodium: "2058.6"
      },
      confidence: {
        score: 0.9500000000000001,
        summary: "Detected Recipe JSON-LD on the page.",
        missingFields: [],
        notes: [],
        fieldProvenance: {
          title: "jsonld",
          ingredients: "jsonld",
          steps: "jsonld",
          servings: "jsonld",
          prepTimeMinutes: "jsonld",
          cookTimeMinutes: "jsonld",
          nutrition: "jsonld"
        }
      }
    },
    extraction: {
      fetchMode: "http",
      provenance: ["jsonld"],
      strategy: "recipe-schema",
      warnings: []
    }
  },
  {
    slug: "pancakes",
    sourceUrl: "https://www.food.com/recipe/pancakes-25690",
    recipe: {
      title: "Pancakes",
      sourceUrl: "https://www.food.com/recipe/pancakes-25690",
      sourceType: "recipe-webpage",
      image: {
        url: "https://img.sndimg.com/food/image/upload/q_92,fl_progressive,w_1200,c_scale/v1/img/recipes/25/69/0/picwslJ1c.jpg",
        source: "jsonld"
      },
      ingredients: [
        {
          text: "3/4 cup milk",
          section: null
        },
        {
          text: "2 tablespoons butter or 2 tablespoons margarine, melted",
          section: null
        },
        {
          text: "1 cup flour",
          section: null
        },
        {
          text: "1 tablespoon sugar (or 1/2 teaspoon honey or molasses)",
          section: null
        },
        {
          text: "1 teaspoon baking powder",
          section: null
        },
        {
          text: "1/2 teaspoon salt",
          section: null
        }
      ],
      steps: [
        {
          index: 1,
          text: "Beat egg until fluffy."
        },
        {
          index: 2,
          text: "Add milk and melted margarine."
        },
        {
          index: 3,
          text: "Add dry ingredients and mix well."
        },
        {
          index: 4,
          text: "Heat a heavy griddle or fry pan which is greased with a little butter on a paper towel."
        },
        {
          index: 5,
          text: "The pan is hot enough when a drop of water breaks into several smaller balls which 'dance' around the pan."
        },
        {
          index: 6,
          text: "Pour a small amount of batter (approx 1/4 cup) into pan and tip to spread out or spread with spoon."
        },
        {
          index: 7,
          text: "When bubbles appear on surface and begin to break, turn over and cook the other side."
        }
      ],
      servings: "9 small pancakes",
      prepTimeMinutes: 5,
      cookTimeMinutes: 5,
      nutrition: {
        calories: "99.8",
        protein: "2.8",
        carbohydrates: "13.1",
        fat: "4",
        fiber: "0.4",
        sugar: "1.5",
        sodium: "210.2"
      },
      confidence: {
        score: 0.9500000000000001,
        summary: "Detected Recipe JSON-LD on the page.",
        missingFields: [],
        notes: [],
        fieldProvenance: {
          title: "jsonld",
          ingredients: "jsonld",
          steps: "jsonld",
          servings: "jsonld",
          prepTimeMinutes: "jsonld",
          cookTimeMinutes: "jsonld",
          nutrition: "jsonld"
        }
      }
    },
    extraction: {
      fetchMode: "http",
      provenance: ["jsonld"],
      strategy: "recipe-schema",
      warnings: []
    }
  },
  {
    slug: "barbecue-ribs",
    sourceUrl: "https://www.food.com/recipe/beths-melt-in-your-mouth-barbecue-ribs-oven-107786",
    recipe: {
      title: "Beth's Melt in Your Mouth Barbecue Ribs (Oven)",
      sourceUrl: "https://www.food.com/recipe/beths-melt-in-your-mouth-barbecue-ribs-oven-107786",
      sourceType: "recipe-webpage",
      image: {
        url: "https://img.sndimg.com/food/image/upload/q_92,fl_progressive,w_1200,c_scale/v1/img/recipes/10/77/86/mr5ViaW4TBmhRU3uCtLB_0S9A8585.jpg",
        source: "jsonld"
      },
      ingredients: [
        {
          text: "4 lbs pork ribs, membrane removed",
          section: null
        },
        {
          text: "3/4 cup light brown sugar",
          section: null
        },
        {
          text: "1 teaspoon hickory smoke salt, if you cannot find, you can substitute 1 1/2 to 2 teaspoons Hickory liquid smoke",
          section: null
        },
        {
          text: "1 tablespoon paprika",
          section: null
        },
        {
          text: "1 tablespoon garlic powder",
          section: null
        },
        {
          text: "1/2 teaspoon ground red pepper (optional)",
          section: null
        },
        {
          text: "2 cups of your favorite barbecue sauce (mine is Sweet Baby Ray)",
          section: null
        }
      ],
      steps: [
        {
          index: 1,
          text: "Preheat oven to 300 degrees F. Line a baking sheet with two layers of foil, shiny side out."
        },
        {
          index: 2,
          text: "Peel off tough membrane that covers the bony side of the ribs."
        },
        {
          index: 3,
          text: "Season the ribs on both sides with salt and pepper. If using, divide the Hickory liquid smoke evenly over the ribs."
        },
        {
          index: 4,
          text: "In a medium bowl, combine the light brown sugar, paprika, garlic powder and ground red pepper. Apply the rub to all sides of the ribs."
        },
        {
          index: 5,
          text: "Lay ribs on the prepared baking sheet, meaty side down. BONE SIDE DOWN FOR GRILLING!"
        },
        {
          index: 6,
          text: "Lay two layers of foil on top of ribs and roll and crimp edges tightly, edges facing up to seal."
        },
        {
          index: 7,
          text: "Transfer to the oven and = bake for 2-2 1/2 hours or until meat is starting to shrink away from the ends of the bone."
        },
        {
          index: 8,
          text: "Heat broiler."
        },
        {
          index: 9,
          text: "Cut ribs into serving sized portions of 2 or 3 ribs."
        },
        {
          index: 10,
          text: "Arrange on broiler pan, bony side up."
        },
        {
          index: 11,
          text: "Broil for 1 or 2 minutes until sauce is cooked on and bubbly."
        },
        {
          index: 12,
          text: "Repeat on other side."
        },
        {
          index: 13,
          text: "Alternately, you can grill the ribs on your grill to cook on the sauce."
        }
      ],
      servings: "6 serving(s)",
      prepTimeMinutes: 15,
      cookTimeMinutes: 180,
      nutrition: {
        calories: "1229.3",
        protein: "71.2",
        carbohydrates: "59",
        fat: "77",
        fiber: "1",
        sugar: "48.5",
        sodium: "872.4"
      },
      confidence: {
        score: 0.9500000000000001,
        summary: "Detected Recipe JSON-LD on the page.",
        missingFields: [],
        notes: [],
        fieldProvenance: {
          title: "jsonld",
          ingredients: "jsonld",
          steps: "jsonld",
          servings: "jsonld",
          prepTimeMinutes: "jsonld",
          cookTimeMinutes: "jsonld",
          nutrition: "jsonld"
        }
      }
    },
    extraction: {
      fetchMode: "http",
      provenance: ["jsonld"],
      strategy: "recipe-schema",
      warnings: []
    }
  },
  {
    slug: "oven-crisp-chicken-wings",
    sourceUrl: "https://www.food.com/recipe/oven-crisp-chicken-wings-40497",
    recipe: {
      title: "Oven Crisp Chicken Wings",
      sourceUrl: "https://www.food.com/recipe/oven-crisp-chicken-wings-40497",
      sourceType: "recipe-webpage",
      image: {
        url: "https://img.sndimg.com/food/image/upload/q_92,fl_progressive,w_1200,c_scale/v1/img/recipes/40/49/7/iUlxb54sSWaD9Zp44kfP_FGgWFV4mSVq8aISp1eQG_baked%20wings%20(1%20of%204).jpg",
        source: "jsonld"
      },
      ingredients: [
        {
          text: "1/3 cup flour",
          section: null
        },
        {
          text: "1 tablespoon paprika",
          section: null
        },
        {
          text: "1 teaspoon garlic salt",
          section: null
        },
        {
          text: "1 teaspoon black pepper",
          section: null
        },
        {
          text: "1/4-1/2 teaspoon cayenne pepper",
          section: null
        },
        {
          text: "3 tablespoons butter",
          section: null
        },
        {
          text: "10 chicken wings, tips removed",
          section: null
        }
      ],
      steps: [
        {
          index: 1,
          text: "Preheat oven to 425 degrees."
        },
        {
          index: 2,
          text: "Be sure wings are thawed and dry them well with paper towels."
        },
        {
          index: 3,
          text: "Combine flour, paprika, garlic salt, black pepper and cayenne pepper in a plastic bag."
        },
        {
          index: 4,
          text: "Shake to mix ingredients and add wings."
        },
        {
          index: 5,
          text: "Line a large baking sheet with Release foil and melt the butter on it. ( Makes for easy clean up.)."
        },
        {
          index: 6,
          text: "Add wings to pan and turn to coat."
        },
        {
          index: 7,
          text: "Bake for 30 minutes."
        },
        {
          index: 8,
          text: "Turn wings over and bake for 15 more minutes or until crispy and done."
        }
      ],
      servings: "4 serving(s)",
      prepTimeMinutes: 20,
      cookTimeMinutes: 45,
      nutrition: {
        calories: "395.4",
        protein: "24.1",
        carbohydrates: "9.9",
        fat: "28.6",
        fiber: "1.1",
        sugar: "0.2",
        sodium: "167.4"
      },
      confidence: {
        score: 0.9500000000000001,
        summary: "Detected Recipe JSON-LD on the page.",
        missingFields: [],
        notes: [],
        fieldProvenance: {
          title: "jsonld",
          ingredients: "jsonld",
          steps: "jsonld",
          servings: "jsonld",
          prepTimeMinutes: "jsonld",
          cookTimeMinutes: "jsonld",
          nutrition: "jsonld"
        }
      }
    },
    extraction: {
      fetchMode: "http",
      provenance: ["jsonld"],
      strategy: "recipe-schema",
      warnings: []
    }
  }
] satisfies FeaturedRecipe[];

export const getFeaturedRecipeBySlug = (slug: string | undefined): FeaturedRecipe | undefined =>
  featuredRecipes.find((recipe) => recipe.slug === slug);
