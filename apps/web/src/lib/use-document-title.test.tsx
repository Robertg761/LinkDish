import { render } from "@testing-library/react";
import React from "react";
import { describe, expect, it } from "vitest";

import { formatDocumentTitle, useDocumentTitle } from "./use-document-title";

const Titled: React.FC<{ title: string | null }> = ({ title }) => {
  useDocumentTitle(title);
  return null;
};

describe("useDocumentTitle", () => {
  it("formats titles with the app name", () => {
    expect(formatDocumentTitle("Cookbook")).toBe("Cookbook · LinkDish");
    expect(formatDocumentTitle("  ")).toBe("LinkDish");
    expect(formatDocumentTitle(undefined)).toBe("LinkDish");
  });

  it("updates document.title and ignores null while loading", () => {
    document.title = "Before";
    const { rerender } = render(<Titled title={null} />);

    expect(document.title).toBe("Before");

    rerender(<Titled title="Banana Bread" />);

    expect(document.title).toBe("Banana Bread · LinkDish");
  });
});
