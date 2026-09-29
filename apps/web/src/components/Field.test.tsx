import { render, screen } from "@testing-library/react";
import React from "react";
import { describe, expect, it } from "vitest";

import { Field, TextAreaField } from "./Field";

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

  it("gives two fields with the same label distinct ids", () => {
    render(
      <>
        <Field label="Email" error="Required" />
        <Field label="Email" />
      </>
    );

    const [first, second] = screen.getAllByLabelText("Email");

    expect(first?.id).toBeTruthy();
    expect(first?.id).not.toBe(second?.id);
    expect(first).toHaveAttribute("aria-describedby", `${first?.id ?? ""}-error`);
    expect(second).not.toHaveAttribute("aria-describedby");
  });

  it("describes the input with its hint until there is an error", () => {
    const { rerender } = render(<Field label="Name" hint="Shown to your household" />);
    const input = screen.getByLabelText("Name");

    expect(input).toHaveAccessibleDescription("Shown to your household");

    rerender(<Field label="Name" hint="Shown to your household" error="Too long" />);

    expect(screen.getByLabelText("Name")).toHaveAccessibleDescription("Too long");
    expect(screen.getByRole("alert")).toHaveTextContent("Too long");
  });

  it("renders a labeled multi-line field", () => {
    render(<TextAreaField label="Notes" defaultValue="Less salt" />);

    expect(screen.getByLabelText("Notes")).toHaveValue("Less salt");
  });
});
