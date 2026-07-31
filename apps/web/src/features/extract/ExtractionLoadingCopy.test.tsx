import { render, screen } from "@testing-library/react";
import React from "react";
import { describe, expect, it } from "vitest";

import { EXTRACTION_LOADING_COPY } from "./extraction-loading-copy";
import { ExtractionLoadingCopy } from "./ExtractionLoadingCopy";

describe("ExtractionLoadingCopy", () => {
  it("exports the extraction loading copy in display order", () => {
    expect(EXTRACTION_LOADING_COPY).toEqual([
      "Warming up the oven…",
      "Skimming off the ads…",
      "Chopping it down to the good stuff…",
      "Tasting for seasoning…",
      "Plating your recipe…"
    ]);
  });

  it("renders the first loading line", () => {
    render(<ExtractionLoadingCopy />);

    expect(screen.getByText(EXTRACTION_LOADING_COPY[0])).toBeInTheDocument();
  });
});
