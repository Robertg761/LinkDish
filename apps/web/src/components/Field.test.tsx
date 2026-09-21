import { render, screen } from "@testing-library/react";
import React from "react";
import { describe, expect, it } from "vitest";

import { Field } from "./Field";

describe("Field", () => {
  it("keeps the generated input id stable across re-renders", () => {
    const { rerender } = render(<Field defaultValue="a" />);
    const firstId = screen.getByRole("textbox").id;

    rerender(<Field defaultValue="b" />);

    expect(screen.getByRole("textbox").id).toBe(firstId);
    expect(firstId).not.toBe("");
  });

  it("links a visible label to its input", () => {
    render(<Field label="Household name" />);

    expect(screen.getByLabelText("Household name")).toBe(screen.getByRole("textbox"));
  });

  it("accepts an aria-label for inputs without a visible label", () => {
    render(<Field aria-label="Recipe URL" />);

    expect(screen.getByRole("textbox", { name: "Recipe URL" })).toBeInTheDocument();
  });
});
