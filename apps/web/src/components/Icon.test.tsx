import { render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { describe, expect, it } from "vitest";

import { Icon } from "./Icon";
import { CORE_ICON_NODES } from "./icons/lucide-icons";

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

  it("draws the rest of the icon set once its chunk loads, holding the same box meanwhile", async () => {
    // The shell and the Cookbook only use core icons; "printer" is in the extended set.
    expect(Object.keys(CORE_ICON_NODES)).not.toContain("printer");
    const { container } = render(<Icon name="printer" size={20} />);
    const svg = container.querySelector("svg");

    expect(svg).toHaveAttribute("width", "20");
    expect(svg).toHaveAttribute("data-icon", "printer");
    await waitFor(() => expect(svg?.querySelectorAll("path, rect").length).toBeGreaterThan(0));
  });

  it("renders the multicolor Google glyph without a stroke", async () => {
    const { container } = render(<Icon name="google" />);
    const svg = container.querySelector("svg");

    expect(svg).toHaveAttribute("viewBox", "0 0 18 18");
    expect(svg).toHaveAttribute("stroke", "none");
    await waitFor(() => expect(svg?.querySelectorAll("path")).toHaveLength(4));
  });

  it("applies a custom color through the style attribute", () => {
    const { container } = render(<Icon name="flame" color="var(--color-tomato)" />);

    expect(container.querySelector("svg")?.getAttribute("style")).toContain("--color-tomato");
  });
});
