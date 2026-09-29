import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { Button } from "./Button";
import { EmptyState } from "./EmptyState";
import { IconButton } from "./IconButton";
import { LoadingState } from "./LoadingState";
import { PageHeader } from "./PageHeader";
import { RecipeCard } from "./RecipeCard";
import { coverCourseRulesReady } from "./RecipeCover";
import { RecipeImage } from "./RecipeImage";

const image = { url: "https://example.com/banana-bread.jpg", source: "og" as const };

describe("RecipeImage", () => {
  it("builds a proxy srcset and reserves an aspect-ratio box", () => {
    const { container } = render(
      <RecipeImage aspectRatio="16 / 9" image={image} sizes="100vw" title="Banana Bread" />
    );

    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img?.getAttribute("src")).toContain("w=480");
    expect(img?.getAttribute("srcset")).toMatch(/w=96 96w, .*w=480 480w, .*w=1200 1200w/);
    expect(img).toHaveAttribute("sizes", "100vw");
    expect(img).toHaveAttribute("loading", "lazy");
    expect(img).toHaveAttribute("decoding", "async");
    expect(screen.getByTestId("recipe-image").getAttribute("style")).toContain("16 / 9");
  });

  it("loads eagerly with high priority for hero images", () => {
    const { container } = render(<RecipeImage image={image} priority title="Banana Bread" />);

    expect(container.querySelector("img")).toHaveAttribute("loading", "eager");
    expect(container.querySelector("img")).toHaveAttribute("fetchpriority", "high");
    expect(container.querySelector("img")).toHaveAttribute("decoding", "async");
    // Shown as soon as it is decoded: a fade from transparent would hold back its paint.
    expect(container.querySelector("img")).not.toHaveClass("fade-image");
  });

  it("fades in the photos further down once they have loaded", () => {
    const { container } = render(<RecipeImage image={image} title="Banana Bread" />);
    const img = container.querySelector("img") as HTMLImageElement;

    expect(img).toHaveClass("fade-image");
    expect(img).not.toHaveClass("is-loaded");
    fireEvent.load(img);
    expect(img).toHaveClass("fade-image", "is-loaded");
  });

  it("falls back to a course-aware cover (never a lone letter) without a photo or on error", async () => {
    const { container, rerender } = render(
      <RecipeImage image={null} title="Brown Butter Chocolate Chip Cookies" />
    );

    const cover = container.querySelector(".recipe-cover");
    expect(cover).toHaveAttribute("aria-hidden", "true");
    // The course rules load beside the page; the cover picks its art up once they're in.
    await coverCourseRulesReady;
    await waitFor(() => expect(cover).toHaveAttribute("data-course", "dessert"));
    expect(cover?.querySelector("[data-icon='cake-slice']")).not.toBeNull();
    expect(cover).toHaveTextContent("");

    rerender(<RecipeImage image={image} title="Weeknight Chicken Soup" />);
    fireEvent.error(container.querySelector("img") as Element);

    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".recipe-cover")).not.toBeNull();

    // A course from the whole recipe wins over the title's guess.
    rerender(<RecipeImage course="drink" image={null} title="Weeknight Chicken Soup" />);
    expect(container.querySelector(".recipe-cover")).toHaveAttribute("data-course", "drink");
  });
});

describe("RecipeCard", () => {
  it("renders the whole card as one link with a separate favorite button", () => {
    render(
      <MemoryRouter>
        <RecipeCard
          badges={<span>Starter</span>}
          favoriteSlot={<IconButton aria-label="Favorite Banana Bread" icon="heart" />}
          image={image}
          meta="1 loaf · 70 min"
          title="Banana Bread"
          to="/recipes/banana"
        />
      </MemoryRouter>
    );

    expect(screen.getByRole("link", { name: "Banana Bread" })).toHaveAttribute(
      "href",
      "/recipes/banana"
    );
    expect(screen.getByRole("button", { name: "Favorite Banana Bread" })).toBeInTheDocument();
    expect(screen.getByText("1 loaf · 70 min")).toBeInTheDocument();
  });

  it("uses a small square thumbnail in the list variant", () => {
    const { container } = render(
      <MemoryRouter>
        <RecipeCard image={image} title="Soup" to="/recipes/soup" variant="list" />
      </MemoryRouter>
    );

    expect(container.querySelector(".recipe-card-list")).not.toBeNull();
    expect(container.querySelector("img")).toHaveAttribute("sizes", "72px");
  });

  it("asks phones for the 480 rendition of a grid card's photo, and takes a shelf's width", () => {
    const { container, rerender } = render(
      <MemoryRouter>
        <RecipeCard image={image} title="Soup" to="/recipes/soup" />
      </MemoryRouter>
    );
    const img = () => container.querySelector("img");

    expect(img()?.getAttribute("srcset")).toMatch(/w=480 480w, .*w=1200 1200w/);
    // A half-width phone card at 3x picks 480 (160 × 3), not 1200.
    expect(img()?.getAttribute("sizes")).toMatch(/, 160px$/);

    rerender(
      <MemoryRouter>
        <RecipeCard imageSizes="156px" image={image} title="Soup" to="/recipes/soup" />
      </MemoryRouter>
    );
    expect(img()).toHaveAttribute("sizes", "156px");
  });
});

describe("PageHeader", () => {
  it("renders an editorial h1 with an italic accent word and actions", () => {
    render(
      <PageHeader
        accent="week"
        actions={<Button>Plan</Button>}
        eyebrow="Meal plan"
        subtitle="Dinner, sorted."
        title="This"
      />
    );

    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading).toHaveTextContent("This week");
    expect(heading.querySelector("em")).toHaveTextContent("week");
    expect(screen.getByRole("button", { name: "Plan" })).toBeInTheDocument();
  });
});

describe("EmptyState", () => {
  it("shows an illustration, copy and actions", () => {
    const { container } = render(
      <EmptyState
        actions={<Button>Add a recipe</Button>}
        body="Paste a link to get started."
        illustration="cookbook"
        title="Nothing simmering yet"
      />
    );

    expect(screen.getByRole("heading", { name: "Nothing simmering yet" })).toBeInTheDocument();
    expect(container.querySelector("svg.illo")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Add a recipe" })).toBeInTheDocument();
  });
});

describe("LoadingState", () => {
  it("keeps a spinner with a visible message by default", () => {
    render(<LoadingState message="Loading recipes" />);

    expect(screen.getByRole("status")).toHaveTextContent("Loading recipes");
  });

  it("draws skeletons with a screen-reader message", () => {
    const { container } = render(<LoadingState message="Loading recipe" variant="recipe" />);

    expect(screen.getByRole("status")).toHaveAttribute("aria-busy", "true");
    expect(screen.getByText("Loading recipe")).toHaveClass("sr-only");
    expect(container.querySelectorAll(".skeleton").length).toBeGreaterThan(3);
  });
});

describe("Button", () => {
  it("renders icons, sizes and a busy state", () => {
    render(
      <Button icon="plus" loading size="lg" variant="accent">
        Add recipe
      </Button>
    );

    const button = screen.getByRole("button", { name: "Add recipe" });
    expect(button).toHaveClass("btn", "btn-accent", "btn-lg");
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
  });
});
