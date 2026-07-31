import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import React from "react";
import { describe, expect, it, vi } from "vitest";

import { ExtractForm } from "./ExtractForm";

describe("ExtractForm", () => {
  it("accepts a valid HTTPS URL", async () => {
    const onSubmit = vi.fn();
    render(<ExtractForm onSubmit={onSubmit} loading={false} />);

    const input = screen.getByPlaceholderText("https://example.com/my-recipe");
    fireEvent.change(input, { target: { value: "https://example.com/recipe" } });
    fireEvent.click(screen.getByText("Extract recipe"));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith("https://example.com/recipe");
    });
  });

  it("accepts a valid HTTP URL", async () => {
    const onSubmit = vi.fn();
    render(<ExtractForm onSubmit={onSubmit} loading={false} />);

    const input = screen.getByPlaceholderText("https://example.com/my-recipe");
    fireEvent.change(input, { target: { value: "http://example.com/recipe" } });
    fireEvent.click(screen.getByText("Extract recipe"));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith("http://example.com/recipe");
    });
  });

  it("rejects empty input", () => {
    const onSubmit = vi.fn();
    render(<ExtractForm onSubmit={onSubmit} loading={false} />);

    const input = screen.getByPlaceholderText("https://example.com/my-recipe");
    const submitButton = screen.getByRole("button", { name: "Extract recipe" });

    expect(submitButton).toBeEnabled();
    fireEvent.click(submitButton);

    expect(onSubmit).not.toHaveBeenCalled();
    expect(input).toHaveFocus();
    expect(screen.getByText("Please paste a recipe link.")).toBeInTheDocument();
  });

  it("rejects non-HTTP(S) URLs", () => {
    const onSubmit = vi.fn();
    render(<ExtractForm onSubmit={onSubmit} loading={false} />);

    const input = screen.getByPlaceholderText("https://example.com/my-recipe");
    fireEvent.change(input, { target: { value: "ftp://example.com/recipe" } });
    fireEvent.click(screen.getByText("Extract recipe"));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText("Only HTTP and HTTPS links are supported.")).toBeInTheDocument();
  });

  it("rejects malformed URLs", () => {
    const onSubmit = vi.fn();
    render(<ExtractForm onSubmit={onSubmit} loading={false} />);

    const input = screen.getByPlaceholderText("https://example.com/my-recipe");
    fireEvent.change(input, { target: { value: "not-a-url" } });
    fireEvent.click(screen.getByText("Extract recipe"));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(
      screen.getByText("Please enter a valid URL (e.g. https://example.com/recipe).")
    ).toBeInTheDocument();
  });

  it("extracts URL from pasted share text", async () => {
    const onSubmit = vi.fn();
    render(<ExtractForm onSubmit={onSubmit} loading={false} />);

    const input = screen.getByPlaceholderText("https://example.com/my-recipe");
    fireEvent.change(input, {
      target: { value: "Check out this recipe https://example.com/recipe yum!" }
    });
    fireEvent.click(screen.getByText("Extract recipe"));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith("https://example.com/recipe");
    });
  });

  it("trims whitespace from input", async () => {
    const onSubmit = vi.fn();
    render(<ExtractForm onSubmit={onSubmit} loading={false} />);

    const input = screen.getByPlaceholderText("https://example.com/my-recipe");
    fireEvent.change(input, { target: { value: "  https://example.com/recipe  " } });
    fireEvent.click(screen.getByText("Extract recipe"));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith("https://example.com/recipe");
    });
  });

  it("opens scan source options instead of launching camera capture directly", () => {
    const onImagesSubmit = vi.fn();
    const { container } = render(
      <ExtractForm onSubmit={vi.fn()} onImagesSubmit={onImagesSubmit} loading={false} />
    );
    const [cameraInput, libraryInput] = Array.from(
      container.querySelectorAll("input[type='file']")
    );
    const cameraClick = vi.spyOn(cameraInput as HTMLInputElement, "click");
    const libraryClick = vi.spyOn(libraryInput as HTMLInputElement, "click");

    fireEvent.click(screen.getByRole("button", { name: "Scan recipe" }));

    const dialog = screen.getByRole("dialog", { name: "Scan Recipe" });

    expect(dialog).toBeInTheDocument();
    expect(dialog.closest(".scan-options-overlay")?.parentElement).toBe(document.body);
    expect(screen.getByRole("button", { name: /take photo/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /choose from library/i })).toBeInTheDocument();
    expect(cameraClick).not.toHaveBeenCalled();
    expect(libraryClick).not.toHaveBeenCalled();
  });

  it("uses separate camera and library file pickers from the scan options", () => {
    const onImagesSubmit = vi.fn();
    const { container } = render(
      <ExtractForm onSubmit={vi.fn()} onImagesSubmit={onImagesSubmit} loading={false} />
    );
    const [cameraInput, libraryInput] = Array.from(
      container.querySelectorAll<HTMLInputElement>("input[type='file']")
    );

    expect(cameraInput?.getAttribute("capture")).toBe("environment");
    expect(cameraInput?.hasAttribute("multiple")).toBe(false);
    expect(libraryInput?.hasAttribute("capture")).toBe(false);
    expect(libraryInput?.hasAttribute("multiple")).toBe(true);

    const cameraClick = vi.spyOn(cameraInput as HTMLInputElement, "click");
    const libraryClick = vi.spyOn(libraryInput as HTMLInputElement, "click");

    fireEvent.click(screen.getByRole("button", { name: "Scan recipe" }));
    fireEvent.click(screen.getByRole("button", { name: /choose from library/i }));

    expect(libraryClick).toHaveBeenCalledTimes(1);
    expect(cameraClick).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Scan recipe" }));
    fireEvent.click(screen.getByRole("button", { name: /take photo/i }));

    expect(cameraClick).toHaveBeenCalledTimes(1);
  });
});
