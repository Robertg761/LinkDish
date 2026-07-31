import { render, screen } from "@testing-library/react";
import React from "react";
import { describe, expect, it } from "vitest";

import { InstallPage } from "./InstallPage";

describe("InstallPage", () => {
  it("does not tell users who are already in the web app to navigate to the same domain", () => {
    render(<InstallPage />);

    expect(screen.getByRole("heading", { name: "Install LinkDish App" })).toBeInTheDocument();
    expect(screen.queryByText(/navigate to\s+app\.linkdish\.xyz/i)).not.toBeInTheDocument();
    expect(screen.getAllByText(/stay on this page/i)).toHaveLength(2);
    expect(screen.getByText(/stay on this LinkDish page/i)).toBeInTheDocument();
  });
});
