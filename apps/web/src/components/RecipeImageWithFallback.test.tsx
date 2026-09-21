import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { describe, expect, it } from "vitest";

import { RecipeImageWithFallback } from "./RecipeImageWithFallback";

describe("RecipeImageWithFallback", () => {
  it("shows the fallback once the image fails", () => {
    render(
      <RecipeImageWithFallback
        src="https://example.com/broken.jpg"
        imageClassName="thumb"
        fallback={<span>No image</span>}
      />
    );

    fireEvent.error(screen.getByRole("presentation", { hidden: true }));

    expect(screen.getByText("No image")).toBeInTheDocument();
  });

  it("retries with a new src instead of staying stuck on the fallback", () => {
    const { rerender } = render(
      <RecipeImageWithFallback
        src="https://example.com/broken.jpg"
        imageClassName="thumb"
        fallback={<span>No image</span>}
      />
    );

    fireEvent.error(screen.getByRole("presentation", { hidden: true }));
    expect(screen.getByText("No image")).toBeInTheDocument();

    rerender(
      <RecipeImageWithFallback
        src="https://example.com/working.jpg"
        imageClassName="thumb"
        fallback={<span>No image</span>}
      />
    );

    expect(screen.queryByText("No image")).not.toBeInTheDocument();
    expect(screen.getByRole("presentation", { hidden: true })).toHaveAttribute(
      "src",
      "https://example.com/working.jpg"
    );
  });
});
