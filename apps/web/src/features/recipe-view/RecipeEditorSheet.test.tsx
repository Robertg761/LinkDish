import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import { describe, expect, it, vi } from "vitest";

import { RecipeEditorSheet } from "./RecipeEditorSheet";

import type { RecipeEditorValues } from "./RecipeEditorSheet";
import type { Recipe } from "@linkdish/recipe-domain";

const recipe: Recipe = {
  confidence: {
    fieldProvenance: {
      cookTimeMinutes: null,
      ingredients: "jsonld",
      nutrition: null,
      prepTimeMinutes: null,
      servings: null,
      steps: "jsonld",
      title: "jsonld"
    },
    missingFields: [],
    notes: [],
    score: 0.9,
    summary: "ok"
  },
  cookTimeMinutes: 30,
  ingredients: [
    { section: "Soup", text: "2 cups stock" },
    { section: "Soup", text: "1 onion" }
  ],
  nutrition: null,
  prepTimeMinutes: 10,
  servings: "4",
  sourceType: "recipe-webpage",
  sourceUrl: "https://example.com/soup",
  steps: [
    { index: 1, text: "Chop the onion." },
    { index: 2, text: "Simmer." }
  ],
  title: "Onion Soup"
};

const renderEditor = (overrides: Partial<React.ComponentProps<typeof RecipeEditorSheet>> = {}) => {
  const props = {
    notes: "Family favourite",
    onClose: vi.fn(),
    onSave: vi.fn().mockResolvedValue(undefined),
    open: true,
    recipe,
    sourceUrl: "https://example.com/soup",
    ...overrides
  };
  render(<RecipeEditorSheet {...props} />);
  return props;
};

describe("RecipeEditorSheet", () => {
  it("fills the form from the recipe, with plain-language sections", () => {
    renderEditor();
    const dialog = screen.getByRole("dialog", { name: "Edit recipe" });

    // A long title wraps in a growing field instead of being cut off in a one-line input.
    const title = within(dialog).getByLabelText("Title");
    expect(title.tagName).toBe("TEXTAREA");
    expect(title).toHaveValue("Onion Soup");
    expect(within(dialog).getByLabelText("Ingredients")).toHaveValue(
      "Soup:\n2 cups stock\n1 onion"
    );
    expect(within(dialog).getByLabelText("Ingredients")).toHaveClass("is-auto-grow");
    expect(within(dialog).getByLabelText("Method")).toHaveValue("Chop the onion.\nSimmer.");
    expect(within(dialog).getByLabelText("Prep (min)")).toHaveValue("10");
    expect(within(dialog).getByLabelText("Source link")).toHaveValue("https://example.com/soup");
    expect(within(dialog).getByLabelText("Notes")).toHaveValue("Family favourite");
  });

  it("closes straight away when nothing changed", () => {
    const props = renderEditor();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(props.onClose).toHaveBeenCalled();
  });

  it("asks before throwing edits away", () => {
    const props = renderEditor();

    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "French Onion Soup" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    const confirm = screen.getByRole("dialog", { name: "Discard changes?" });
    expect(props.onClose).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole("button", { name: "Keep editing" }));
    expect(screen.getByLabelText("Title")).toHaveValue("French Onion Soup");

    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "Discard changes?" })).getByRole("button", {
        name: "Discard"
      })
    );
    expect(props.onClose).toHaveBeenCalled();
  });

  it("validates before saving", () => {
    const props = renderEditor();

    fireEvent.change(screen.getByLabelText("Title"), { target: { value: " " } });
    fireEvent.change(screen.getByLabelText("Prep (min)"), { target: { value: "ten" } });
    fireEvent.change(screen.getByLabelText("Source link"), { target: { value: "example" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(screen.getByText("Give the recipe a name.")).toBeInTheDocument();
    expect(screen.getByText("Whole minutes, e.g. 15.")).toBeInTheDocument();
    expect(screen.getByText("Use a full link starting with https://")).toBeInTheDocument();
    expect(props.onSave).not.toHaveBeenCalled();
  });

  it("saves the edited recipe, sections, times, source and notes", async () => {
    const props = renderEditor();

    fireEvent.change(screen.getByLabelText("Ingredients"), {
      target: { value: "## Soup\n2 cups stock\n\n## To serve\nCroutons" }
    });
    fireEvent.change(screen.getByLabelText("Cook (min)"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Source link"), {
      target: { value: "https://example.com/better-soup" }
    });
    fireEvent.change(screen.getByLabelText("Notes"), { target: { value: "  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(props.onSave).toHaveBeenCalled());
    const [values] = vi.mocked(props.onSave).mock.calls[0] as [RecipeEditorValues];
    expect(values.notes).toBeNull();
    expect(values.sourceUrl).toBe("https://example.com/better-soup");
    expect(values.recipe).toMatchObject({
      cookTimeMinutes: null,
      ingredients: [
        { section: "Soup", text: "2 cups stock" },
        { section: "To serve", text: "Croutons" }
      ],
      prepTimeMinutes: 10,
      sourceUrl: "https://example.com/better-soup",
      steps: [
        { index: 1, text: "Chop the onion." },
        { index: 2, text: "Simmer." }
      ],
      title: "Onion Soup"
    });
    expect(values.changes).toEqual({
      notes: null,
      recipe: {
        cookTimeMinutes: null,
        ingredients: [
          { section: "Soup", text: "2 cups stock" },
          { section: "To serve", text: "Croutons" }
        ],
        sourceUrl: "https://example.com/better-soup"
      }
    });
    await waitFor(() => expect(props.onClose).toHaveBeenCalled());
  });

  it("sends only what the cook changed since the editor opened", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    const props = {
      notes: "Family favourite",
      onClose,
      onSave,
      open: true,
      recipe,
      sourceUrl: "https://example.com/soup"
    };
    const { rerender } = render(<RecipeEditorSheet {...props} />);

    // A note and a new title arrive from another tab while the editor is open.
    rerender(
      <RecipeEditorSheet
        {...props}
        notes="Saved in another tab"
        recipe={{ ...recipe, title: "Golden Onion Soup" }}
      />
    );
    // What the editor shows stays as it opened, and nothing counts as an unsaved edit.
    expect(screen.getByLabelText("Title")).toHaveValue("Onion Soup");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog", { name: "Discard changes?" })).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Servings"), { target: { value: " 6 " } });
    // Edits that save the same value as before are no change.
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Onion Soup " } });
    fireEvent.change(screen.getByLabelText("Method"), {
      target: { value: "Chop the onion.\n\nSimmer.\n" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const [values] = onSave.mock.calls[0] as [RecipeEditorValues];
    expect(values.changes).toEqual({ recipe: { servings: "6" } });
    // The whole recipe (for a family recipe) is the newest one with the cook's change.
    expect(values.notes).toBe("Saved in another tab");
    expect(values.recipe).toMatchObject({ servings: "6", title: "Golden Onion Soup" });
    expect(values).not.toHaveProperty("sourceUrl");
  });

  it("never offers the synthetic source link of a photo import", () => {
    renderEditor({ sourceUrl: null });

    expect(screen.queryByLabelText("Source link")).not.toBeInTheDocument();
  });

  it("keeps the sheet open and explains a failed save", async () => {
    const props = renderEditor({ onSave: vi.fn().mockRejectedValue(new Error("disk full")) });

    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Soup" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(props.onClose).not.toHaveBeenCalled();
  });
});
