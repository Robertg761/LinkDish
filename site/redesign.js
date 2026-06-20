const recipes = {
  lemon: {
    url: "https://weeknightbites.com/lemony-orzo",
    kicker: "ONE-POT WEEKDAY",
    title: "Lemony orzo with greens",
    time: "25 min",
    serves: "Serves 4",
    art: "art--lemon",
    ingredients: [
      ["1 1/2 cups orzo", "280 g"],
      ["Vegetable stock", "3 cups"],
      ["Baby spinach", "2 handfuls"],
      ["Lemon, zest and juice", "1"],
      ["Garlic cloves, minced", "3"],
      ["Parmesan, finely grated", "1/2 cup"],
      ["Extra-virgin olive oil", "2 tbsp"],
      ["Sea salt and black pepper", "to taste"],
    ],
    steps: [
      [
        "Warm the pan",
        "Warm olive oil in a wide pan. Add garlic and cook until fragrant.",
      ],
      [
        "Toast the orzo",
        "Stir in the orzo and toast for one minute, coating every grain.",
      ],
      [
        "Simmer until glossy",
        "Add the stock and simmer, stirring often, until the orzo is tender.",
      ],
      [
        "Fold in the spinach",
        "Stir in the spinach a handful at a time until just wilted. Remove from heat.",
      ],
      [
        "Finish with lemon",
        "Add lemon zest, juice, and parmesan. Season, spoon into bowls, and serve.",
      ],
    ],
  },
  tacos: {
    url: "https://coastalkitchen.com/crispy-fish-tacos",
    kicker: "BRIGHT CRUNCHY",
    title: "Crispy fish tacos",
    time: "35 min",
    serves: "Serves 4",
    art: "art--tacos",
    ingredients: [
      ["White fish fillets", "600 g"],
      ["Small corn tortillas", "8"],
      ["Shredded cabbage", "3 cups"],
      ["Lime, cut in wedges", "2"],
      ["Plain yogurt", "1/2 cup"],
      ["Smoked paprika", "1 tsp"],
      ["Avocado, sliced", "1"],
      ["Cilantro leaves", "1 handful"],
    ],
    steps: [
      [
        "Season the fish",
        "Pat the fish dry, then season with salt, pepper, and smoked paprika.",
      ],
      [
        "Make the slaw",
        "Toss cabbage with lime juice, a pinch of salt, and half the cilantro.",
      ],
      [
        "Cook until crisp",
        "Sear the fish in a hot skillet until golden and flaky, about three minutes per side.",
      ],
      [
        "Warm the tortillas",
        "Toast tortillas directly in a dry pan until soft and lightly charred.",
      ],
      [
        "Build the tacos",
        "Layer yogurt, slaw, fish, and avocado. Finish with cilantro and lime.",
      ],
    ],
  },
  cookies: {
    url: "https://bakesomething.com/chocolate-chunk-cookies",
    kicker: "CHEWY SMALL BATCH",
    title: "Chocolate chunk cookies",
    time: "28 min",
    serves: "Makes 12",
    art: "art--cookies",
    ingredients: [
      ["Unsalted butter, softened", "1/2 cup"],
      ["Light brown sugar", "3/4 cup"],
      ["Large egg", "1"],
      ["Vanilla extract", "1 tsp"],
      ["All-purpose flour", "1 1/4 cups"],
      ["Baking soda", "1/2 tsp"],
      ["Dark chocolate, chopped", "150 g"],
      ["Flaky sea salt", "a pinch"],
    ],
    steps: [
      [
        "Heat the oven",
        "Set the oven to 350 F and line a baking sheet.",
      ],
      [
        "Cream butter and sugar",
        "Beat the softened butter and brown sugar until pale and fluffy.",
      ],
      [
        "Mix the dough",
        "Beat in the egg and vanilla, then fold in flour, baking soda, and chocolate.",
      ],
      [
        "Portion and bake",
        "Scoop twelve cookies and bake until golden at the edges, 10 to 12 minutes.",
      ],
      [
        "Cool and finish",
        "Sprinkle with flaky salt and cool on the tray for ten minutes.",
      ],
    ],
  },
};

let activeRecipeKey = "lemon";
let activeStepIndex = 0;
let toastTimer;
let cleaningTimer;
let lastFocusedElement = null;

const body = document.body;
const header = document.querySelector(".site-header");
const heroVisual = document.querySelector(".hero-visual");
const cleanerForm = document.getElementById("cleaner-form");
const recipeUrl = document.getElementById("recipe-url");
const formError = document.getElementById("form-error");
const cleanStatus = document.getElementById("clean-status");
const recipeArt = document.getElementById("recipe-art");
const recipeKicker = document.getElementById("recipe-kicker");
const recipeTitle = document.getElementById("recipe-title");
const recipeTime = document.getElementById("recipe-time");
const recipeServes = document.getElementById("recipe-serves");
const badgeTime = document.getElementById("badge-time");
const ingredientList = document.getElementById("ingredient-list");
const stepList = document.getElementById("step-list");
const ingredientCount = document.getElementById("ingredient-count");
const stepCount = document.getElementById("step-count");
const toast = document.getElementById("toast");
const cookModal = document.getElementById("cook-modal");
const modalTitle = document.getElementById("modal-title");
const modalStepCopy = document.getElementById("modal-step-copy");
const modalStepLabel = document.getElementById("modal-step-label");
const modalProgressBar = document.getElementById("modal-progress-bar");
const modalPrev = document.getElementById("modal-prev");
const modalNext = document.getElementById("modal-next");

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderRecipe(key) {
  const recipe = recipes[key] || recipes.lemon;
  activeRecipeKey = key in recipes ? key : "lemon";
  recipeKicker.textContent = recipe.kicker;
  recipeTitle.textContent = recipe.title;
  recipeTime.textContent = recipe.time;
  recipeServes.textContent = recipe.serves;
  badgeTime.textContent = recipe.time;
  recipeArt.className = `recipe-art ${recipe.art}`;
  ingredientCount.textContent = recipe.ingredients.length;
  stepCount.textContent = recipe.steps.length;

  ingredientList.innerHTML = recipe.ingredients
    .slice(0, 4)
    .map(
      ([name, amount]) => `
        <li>
          <button class="check-dot" type="button" aria-label="Check off ${escapeHtml(name)}"></button>
          <span>${escapeHtml(name)}</span>
          <b>${escapeHtml(amount)}</b>
        </li>
      `,
    )
    .join("");

  stepList.innerHTML = recipe.steps
    .slice(0, 3)
    .map(
      ([title, copy], index) => `
        <li>
          <span>${index + 1}</span>
          <p><strong>${escapeHtml(title)}.</strong> ${escapeHtml(copy)}</p>
        </li>
      `,
    )
    .join("");

  document.querySelectorAll(".sample-chip").forEach((chip) => {
    chip.classList.toggle("is-active", chip.dataset.recipe === activeRecipeKey);
  });
  activeStepIndex = 0;
}

function chooseRecipeFromUrl(value) {
  const normalized = value.toLowerCase();
  if (normalized.includes("taco") || normalized.includes("fish")) {
    return "tacos";
  }
  if (
    normalized.includes("cookie") ||
    normalized.includes("chocolate") ||
    normalized.includes("bake")
  ) {
    return "cookies";
  }
  return "lemon";
}

function showToast(message) {
  toast.querySelector("span").textContent = message;
  toast.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("is-visible"), 2600);
}

function cleanRecipe(key) {
  clearTimeout(cleaningTimer);
  formError.textContent = "";
  body.classList.add("is-cleaning");
  heroVisual.classList.remove("is-cleaned");
  cleanStatus.textContent = "Cleaning recipe link.";

  cleaningTimer = window.setTimeout(() => {
    renderRecipe(key);
    body.classList.remove("is-cleaning");
    heroVisual.classList.add("is-cleaned");
    cleanStatus.textContent = `${recipes[key].title} is cleaned and ready.`;
    showToast(`${recipes[key].title} is ready.`);
  }, 1050);
}

cleanerForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const value = recipeUrl.value.trim();
  if (!value) {
    formError.textContent =
      "Paste a recipe link first, or tap one of the samples below.";
    recipeUrl.focus();
    return;
  }

  let normalizedValue = value;
  if (!/^https?:\/\//i.test(normalizedValue)) {
    normalizedValue = `https://${normalizedValue}`;
  }

  try {
    const parsed = new URL(normalizedValue);
    if (!parsed.hostname.includes(".")) {
      throw new Error("Invalid host");
    }
    recipeUrl.value = normalizedValue;
    cleanRecipe(chooseRecipeFromUrl(normalizedValue));
  } catch {
    formError.textContent = "That does not look like a full recipe URL.";
    recipeUrl.focus();
  }
});

recipeUrl.addEventListener("input", () => {
  formError.textContent = "";
});

document.querySelectorAll(".sample-chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    const key = chip.dataset.recipe;
    recipeUrl.value = recipes[key].url;
    cleanRecipe(key);
  });
});

document.querySelectorAll(".recipe-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    const selected = tab.dataset.tab;
    document.querySelectorAll(".recipe-tab").forEach((item) => {
      const isActive = item === tab;
      item.classList.toggle("is-active", isActive);
      item.setAttribute("aria-selected", String(isActive));
    });
    document.getElementById("ingredients-panel").hidden = selected !== "ingredients";
    document.getElementById("steps-panel").hidden = selected !== "steps";
  });
});

ingredientList.addEventListener("click", (event) => {
  const check = event.target.closest(".check-dot");
  if (!check) {
    return;
  }
  const row = check.closest("li");
  row.classList.toggle("is-checked");
  check.setAttribute("aria-pressed", String(row.classList.contains("is-checked")));
});

const saveButton = document.querySelector(".save-button");
saveButton.addEventListener("click", () => {
  const willSave = saveButton.getAttribute("aria-pressed") !== "true";
  saveButton.setAttribute("aria-pressed", String(willSave));
  showToast(
    willSave ? "Recipe saved to your cookbook." : "Recipe removed from saved recipes.",
  );
});

function updateCookModal() {
  const recipe = recipes[activeRecipeKey];
  const [title, copy] = recipe.steps[activeStepIndex];
  modalTitle.textContent = title;
  modalStepCopy.textContent = copy;
  modalStepLabel.textContent = `STEP ${activeStepIndex + 1} OF ${recipe.steps.length}`;
  modalProgressBar.style.width = `${((activeStepIndex + 1) / recipe.steps.length) * 100}%`;
  modalPrev.disabled = activeStepIndex === 0;
  modalNext.textContent =
    activeStepIndex === recipe.steps.length - 1 ? "Finish cooking" : "Next step";
}

function openCookModal() {
  lastFocusedElement = document.activeElement;
  activeStepIndex = 0;
  updateCookModal();
  cookModal.hidden = false;
  body.classList.add("modal-open");
  document.querySelector(".modal-close").focus();
}

function closeCookModal() {
  cookModal.hidden = true;
  body.classList.remove("modal-open");
  if (lastFocusedElement) {
    lastFocusedElement.focus();
  }
}

document.getElementById("cook-button").addEventListener("click", openCookModal);
document
  .querySelectorAll("[data-close-modal]")
  .forEach((element) => element.addEventListener("click", closeCookModal));

modalPrev.addEventListener("click", () => {
  if (activeStepIndex > 0) {
    activeStepIndex -= 1;
  }
  updateCookModal();
});

modalNext.addEventListener("click", () => {
  const lastIndex = recipes[activeRecipeKey].steps.length - 1;
  if (activeStepIndex < lastIndex) {
    activeStepIndex += 1;
    updateCookModal();
  } else {
    closeCookModal();
    showToast("Dinner is ready. Nice work.");
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !cookModal.hidden) {
    closeCookModal();
  }
  if (!cookModal.hidden && event.key === "ArrowRight") {
    modalNext.click();
  }
  if (!cookModal.hidden && event.key === "ArrowLeft" && !modalPrev.disabled) {
    modalPrev.click();
  }
});

document.querySelectorAll(".billing-toggle button").forEach((button) => {
  button.addEventListener("click", () => {
    const billing = button.dataset.billing;
    document.querySelectorAll(".billing-toggle button").forEach((item) => {
      const isActive = item === button;
      item.classList.toggle("is-active", isActive);
      item.setAttribute("aria-pressed", String(isActive));
    });
    document
      .querySelector(".pricing-section")
      .classList.toggle("billing-yearly", billing === "yearly");
    document.querySelectorAll("[data-monthly][data-yearly]").forEach((element) => {
      element.textContent = element.dataset[billing];
    });
  });
});

document.querySelectorAll(".faq-item h3 button").forEach((button) => {
  button.addEventListener("click", () => {
    const item = button.closest(".faq-item");
    const answer = item.querySelector(".faq-answer");
    const isOpen = item.classList.contains("is-open");
    document.querySelectorAll(".faq-item").forEach((otherItem) => {
      otherItem.classList.remove("is-open");
      otherItem.querySelector("button").setAttribute("aria-expanded", "false");
      otherItem.querySelector(".faq-answer").hidden = true;
    });
    if (!isOpen) {
      item.classList.add("is-open");
      button.setAttribute("aria-expanded", "true");
      answer.hidden = false;
    }
  });
});

const menuToggle = document.querySelector(".menu-toggle");
const mainNav = document.querySelector(".main-nav");
menuToggle.addEventListener("click", () => {
  const isOpen = menuToggle.getAttribute("aria-expanded") === "true";
  menuToggle.setAttribute("aria-expanded", String(!isOpen));
  mainNav.classList.toggle("is-open", !isOpen);
  header.classList.toggle("is-menu-open", !isOpen);
});

mainNav.addEventListener("click", (event) => {
  if (!event.target.closest("a")) {
    return;
  }
  menuToggle.setAttribute("aria-expanded", "false");
  mainNav.classList.remove("is-open");
  header.classList.remove("is-menu-open");
});

window.addEventListener(
  "scroll",
  () => {
    header.classList.toggle("is-scrolled", window.scrollY > 8);
  },
  { passive: true },
);

if ("IntersectionObserver" in window) {
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          observer.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.12, rootMargin: "0px 0px -40px" },
  );

  document.querySelectorAll(".reveal").forEach((element) => observer.observe(element));
} else {
  document.querySelectorAll(".reveal").forEach((element) => {
    element.classList.add("is-visible");
  });
}

document.getElementById("current-year").textContent = new Date().getFullYear();
renderRecipe("lemon");
