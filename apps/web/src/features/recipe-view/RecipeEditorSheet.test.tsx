import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import { describe, expect, it, vi } from "vitest";

import { RecipeEditorSheet } from "./RecipeEditorSheet";

import type { RecipeEditorValues } from "./RecipeEditorSheet";
import type { Recipe, RecipeImage } from "@linkdish/recipe-domain";

const photoMocks = vi.hoisted(() => ({ prepareRecipePhoto: vi.fn() }));

vi.mock("../extract/image-downscale", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  prepareRecipePhoto: photoMocks.prepareRecipePhoto
}));

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

  describe("the picture", () => {
    const facebookThumbnail: RecipeImage = {
      source: "og",
      url: "https://cdn.example.com/thumbnail.jpg"
    };
    const uploaded: RecipeImage = {
      height: 900,
      source: "content",
      url: "https://api.example.com/image/photos/abc.webp",
      width: 1200
    };
    const withPicture = { ...recipe, image: facebookThumbnail };
    const savedValues = (props: ReturnType<typeof renderEditor>) =>
      vi.mocked(props.onSave).mock.calls[0]?.[0] as RecipeEditorValues;

    const choosePhoto = async () => {
      photoMocks.prepareRecipePhoto.mockResolvedValue({
        dataUrl: "data:image/jpeg;base64,abc",
        height: 900,
        mimeType: "image/jpeg",
        width: 1200
      });
      fireEvent.change(screen.getByLabelText("Choose a picture"), {
        target: { files: [new File(["photo"], "dinner.jpg", { type: "image/jpeg" })] }
      });
      await screen.findByAltText("Your new recipe picture");
    };

    const choosePhotoSlowly = () => {
      let finish = (): void => undefined;

      photoMocks.prepareRecipePhoto.mockReturnValue(
        new Promise((resolve) => {
          finish = () =>
            resolve({
              dataUrl: "data:image/jpeg;base64,late",
              height: 9,
              mimeType: "image/jpeg",
              width: 9
            });
        })
      );
      fireEvent.change(screen.getByLabelText("Choose a picture"), {
        target: { files: [new File(["photo"], "dinner.jpg", { type: "image/jpeg" })] }
      });

      return () => finish();
    };

    it("won't save while a chosen picture is still being prepared", async () => {
      const onUploadPhoto = vi.fn().mockResolvedValue(uploaded);
      const props = renderEditor({ onUploadPhoto, recipe: withPicture });

      const finish = choosePhotoSlowly();

      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled()
      );
      fireEvent.submit(document.querySelector(".recipe-editor-form") as HTMLFormElement);
      expect(props.onSave).not.toHaveBeenCalled();

      finish();
      await screen.findByAltText("Your new recipe picture");
      fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

      await waitFor(() => expect(props.onSave).toHaveBeenCalled());
      expect(onUploadPhoto).toHaveBeenCalledWith("data:image/jpeg;base64,late");
    });

    it("drops a picture still being prepared when the cook removes it instead", async () => {
      renderEditor({ onUploadPhoto: vi.fn(), recipe: withPicture });

      const finish = choosePhotoSlowly();
      fireEvent.click(screen.getByRole("button", { name: "Remove" }));
      finish();

      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled()
      );
      expect(screen.queryByAltText("Your new recipe picture")).not.toBeInTheDocument();
    });

    it("doesn't let a late picture into an editor opened again", async () => {
      const props = { onClose: vi.fn(), onSave: vi.fn(), onUploadPhoto: vi.fn(), notes: "" };
      const editor = (open: boolean) => (
        <RecipeEditorSheet {...props} open={open} recipe={withPicture} />
      );
      const { rerender } = render(editor(true));

      const finish = choosePhotoSlowly();
      rerender(editor(false));
      rerender(editor(true));
      finish();

      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled()
      );
      expect(screen.queryByAltText("Your new recipe picture")).not.toBeInTheDocument();
    });

    it("leaves the picture out of a save that didn't touch it", async () => {
      const props = renderEditor({ onUploadPhoto: vi.fn(), recipe: withPicture });

      fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Grandma's Soup" } });
      fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

      await waitFor(() => expect(props.onSave).toHaveBeenCalled());
      expect(savedValues(props).changes.recipe).toEqual({ title: "Grandma's Soup" });
    });

    it("uploads a chosen picture on save, not before", async () => {
      const onUploadPhoto = vi.fn().mockResolvedValue(uploaded);
      const props = renderEditor({ onUploadPhoto, recipe: withPicture });

      await choosePhoto();
      expect(onUploadPhoto).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

      await waitFor(() => expect(props.onSave).toHaveBeenCalled());
      expect(onUploadPhoto).toHaveBeenCalledWith("data:image/jpeg;base64,abc");
      expect(savedValues(props).changes.recipe).toEqual({ image: uploaded });
      expect(savedValues(props).recipe.image).toEqual(uploaded);
    });

    it("sends nothing when a chosen picture is abandoned", async () => {
      const onUploadPhoto = vi.fn();
      const props = renderEditor({ onUploadPhoto, recipe: withPicture });

      await choosePhoto();
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      fireEvent.click(
        within(screen.getByRole("dialog", { name: "Discard changes?" })).getByRole("button", {
          name: "Discard"
        })
      );

      expect(props.onClose).toHaveBeenCalled();
      expect(onUploadPhoto).not.toHaveBeenCalled();
    });

    it("removes the picture without uploading anything", async () => {
      const onUploadPhoto = vi.fn();
      const props = renderEditor({ onUploadPhoto, recipe: withPicture });

      fireEvent.click(screen.getByRole("button", { name: "Remove" }));
      expect(screen.getByRole("button", { name: "Add picture" })).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

      await waitFor(() => expect(props.onSave).toHaveBeenCalled());
      expect(savedValues(props).changes.recipe).toEqual({ image: null });
      expect(onUploadPhoto).not.toHaveBeenCalled();
    });

    it("explains why there's no picture button when signed out, and still allows removing", () => {
      renderEditor({ recipe: withPicture });

      expect(screen.getByText("Sign in to use your own picture.")).toBeInTheDocument();
      expect(screen.queryByLabelText("Choose a picture")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Remove" })).toBeInTheDocument();
    });

    it("stays open with the reason when a photo can't be read", async () => {
      const { PhotoPrepError } = await import("../extract/image-downscale");
      photoMocks.prepareRecipePhoto.mockRejectedValue(
        new PhotoPrepError("not_image", "Not a photo.")
      );
      renderEditor({ onUploadPhoto: vi.fn(), recipe: withPicture });

      fireEvent.change(screen.getByLabelText("Choose a picture"), {
        target: { files: [new File(["x"], "notes.txt", { type: "text/plain" })] }
      });

      expect(await screen.findByRole("alert")).toHaveTextContent("Not a photo.");
    });

    it("keeps the editor open when the upload fails, and saves nothing", async () => {
      const onUploadPhoto = vi.fn().mockRejectedValue(new Error("offline"));
      const props = renderEditor({ onUploadPhoto, recipe: withPicture });

      await choosePhoto();
      fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

      expect(await screen.findByRole("alert")).toBeInTheDocument();
      expect(props.onSave).not.toHaveBeenCalled();
      expect(props.onClose).not.toHaveBeenCalled();
    });

    it("doesn't upload the picture again when retrying a save that failed after it", async () => {
      const onUploadPhoto = vi.fn().mockResolvedValue(uploaded);
      const onSave = vi.fn().mockRejectedValueOnce(new Error("nope")).mockResolvedValue(undefined);
      renderEditor({ onSave, onUploadPhoto, recipe: withPicture });

      await choosePhoto();
      fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
      await screen.findByRole("alert");
      fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

      await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
      expect(onUploadPhoto).toHaveBeenCalledTimes(1);
    });
  });
});
