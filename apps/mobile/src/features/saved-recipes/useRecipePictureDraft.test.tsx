import React from "react";
import { act, create } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useRecipePictureDraft } from "./useRecipePictureDraft";

import type { RecipeImage } from "@linkdish/recipe-domain";

const mocks = vi.hoisted(() => ({
  launchImageLibraryAsync: vi.fn(),
  prepareRecipePicture: vi.fn()
}));

vi.mock("expo-image-picker", () => ({ launchImageLibraryAsync: mocks.launchImageLibraryAsync }));
vi.mock("../recipe-intake/preparePickedImages", () => ({
  prepareRecipePicture: mocks.prepareRecipePicture
}));
vi.mock("../../lib/recipeImage", () => ({
  buildProxiedRecipeImageUrl: (image: RecipeImage | null) => (image ? `proxied:${image.url}` : null)
}));

const thumbnail: RecipeImage = { source: "og", url: "https://cdn.example.com/thumb.jpg" };
const uploaded: RecipeImage = {
  height: 900,
  source: "content",
  url: "https://api.example.com/image/photos/abc.webp",
  width: 1200
};
const asset = { height: 3000, uri: "file:///photo.jpg", width: 4000 };

type Draft = ReturnType<typeof useRecipePictureDraft>;

const renderDraft = (upload: (dataUrl: string) => Promise<RecipeImage>) => {
  const result = {} as { current: Draft };
  const Probe = () => {
    result.current = useRecipePictureDraft(upload);
    return null;
  };

  act(() => {
    create(<Probe />);
  });

  return result;
};

const pick = async (result: { current: Draft }) => {
  mocks.launchImageLibraryAsync.mockResolvedValue({ assets: [asset], canceled: false });
  mocks.prepareRecipePicture.mockResolvedValue("data:image/jpeg;base64,abc");
  await act(() => result.current.choose());
};

describe("useRecipePictureDraft", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("keeps the saved picture until something changes", async () => {
    const upload = vi.fn();
    const result = renderDraft(upload);

    expect(result.current.preview(thumbnail)).toBe(`proxied:${thumbnail.url}`);
    await expect(result.current.resolve(thumbnail)).resolves.toBe(thumbnail);
    expect(upload).not.toHaveBeenCalled();
  });

  it("shows a chosen picture at once and uploads it only on save", async () => {
    const upload = vi.fn().mockResolvedValue(uploaded);
    const result = renderDraft(upload);

    await pick(result);

    expect(result.current.preview(thumbnail)).toBe(asset.uri);
    expect(upload).not.toHaveBeenCalled();

    await act(async () => {
      await expect(result.current.resolve(thumbnail)).resolves.toBe(uploaded);
    });
    expect(upload).toHaveBeenCalledWith("data:image/jpeg;base64,abc");
  });

  it("doesn't upload a picture twice when the save is tried again", async () => {
    const upload = vi.fn().mockResolvedValue(uploaded);
    const result = renderDraft(upload);

    await pick(result);
    await act(async () => {
      await result.current.resolve(thumbnail);
    });
    await act(async () => {
      await expect(result.current.resolve(thumbnail)).resolves.toBe(uploaded);
    });

    expect(upload).toHaveBeenCalledTimes(1);
  });

  it("passes on a failed upload and can try it again", async () => {
    const upload = vi.fn().mockRejectedValueOnce(new Error("offline"));
    upload.mockResolvedValue(uploaded);
    const result = renderDraft(upload);

    await pick(result);
    await act(async () => {
      await expect(result.current.resolve(thumbnail)).rejects.toThrow("offline");
    });
    await act(async () => {
      await expect(result.current.resolve(thumbnail)).resolves.toBe(uploaded);
    });
  });

  it("removes the picture without an upload", async () => {
    const upload = vi.fn();
    const result = renderDraft(upload);

    act(() => result.current.remove());

    expect(result.current.preview(thumbnail)).toBeNull();
    await expect(result.current.resolve(thumbnail)).resolves.toBeNull();
    expect(upload).not.toHaveBeenCalled();
  });

  it("changes nothing when the picker is cancelled", async () => {
    mocks.launchImageLibraryAsync.mockResolvedValue({ assets: null, canceled: true });
    const result = renderDraft(vi.fn());

    await act(() => result.current.choose());

    expect(result.current.preview(thumbnail)).toBe(`proxied:${thumbnail.url}`);
    expect(result.current.error).toBeNull();
  });

  it("says so when a picture can't be opened, and keeps the current one", async () => {
    mocks.launchImageLibraryAsync.mockResolvedValue({ assets: [asset], canceled: false });
    mocks.prepareRecipePicture.mockRejectedValue(new Error("corrupt"));
    const result = renderDraft(vi.fn());

    await act(() => result.current.choose());

    expect(result.current.error).toMatch(/could not be opened/u);
    expect(result.current.preview(thumbnail)).toBe(`proxied:${thumbnail.url}`);
  });

  it("forgets a chosen picture when the editor opens again", async () => {
    const upload = vi.fn();
    const result = renderDraft(upload);

    await pick(result);
    act(() => result.current.reset());

    expect(result.current.preview(thumbnail)).toBe(`proxied:${thumbnail.url}`);
    await expect(result.current.resolve(thumbnail)).resolves.toBe(thumbnail);
    expect(upload).not.toHaveBeenCalled();
  });
});
