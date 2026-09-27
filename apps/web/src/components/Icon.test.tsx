import { render, screen } from "@testing-library/react";
import React from "react";
import { describe, expect, it } from "vitest";

import { Icon } from "./Icon";

describe("Icon", () => {
  it("renders an inline, decorative SVG by default", () => {
    const { container } = render(<Icon name="heart" size={18} />);
    const svg = container.querySelector("svg");

    expect(svg).not.toBeNull();
    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(svg).toHaveAttribute("width", "18");
    expect(svg).toHaveAttribute("data-icon", "heart");
    expect(svg?.querySelectorAll("path").length).toBeGreaterThan(0);
  });

  it("exposes an accessible name when a title is given", () => {
    render(<Icon name="wifi-off" title="Offline" />);

    expect(screen.getByRole("img", { name: "Offline" })).toBeInTheDocument();
  });

  it("renders the multicolor Google glyph without a stroke", () => {
    const { container } = render(<Icon name="google" />);
    const svg = container.querySelector("svg");

    expect(svg).toHaveAttribute("viewBox", "0 0 18 18");
    expect(svg).toHaveAttribute("stroke", "none");
    expect(svg?.querySelectorAll("path")).toHaveLength(4);
  });

  it("applies a custom color through the style attribute", () => {
    const { container } = render(<Icon name="flame" color="var(--color-tomato)" />);

    expect(container.querySelector("svg")?.getAttribute("style")).toContain("--color-tomato");
  });
});
