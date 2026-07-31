import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createShareCardBlob, drawShareCard } from "./share-card";

const createContextMock = () => {
  const fillTextMock = vi.fn();
  const context = {
    fillRect: vi.fn(),
    fillText: fillTextMock,
    measureText: vi.fn((text: string) => ({ width: text.length * 24 }) as TextMetrics),
    strokeRect: vi.fn()
  } as unknown as CanvasRenderingContext2D;

  return { context, fillTextMock };
};

describe("share-card", () => {
  let context: CanvasRenderingContext2D;
  let fillTextMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    const mock = createContextMock();
    context = mock.context;
    fillTextMock = mock.fillTextMock;

    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
      configurable: true,
      value: vi.fn((contextId: string) => (contextId === "2d" ? context : null))
    });

    Object.defineProperty(HTMLCanvasElement.prototype, "toBlob", {
      configurable: true,
      value(callback: BlobCallback) {
        callback(new Blob(["share-card"], { type: "image/png" }));
      }
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("draws a 1200 by 630 branded canvas", () => {
    const canvas = drawShareCard({
      sourceUrl: "https://www.example.com/recipes/pasta",
      title: "Creamy Lemon Pasta With Herbs"
    });

    expect(canvas.width).toBe(1200);
    expect(canvas.height).toBe(630);
    expect(fillTextMock).toHaveBeenCalledWith("LINKDISH", expect.any(Number), expect.any(Number));
    expect(fillTextMock).toHaveBeenCalledWith(
      "example.com",
      expect.any(Number),
      expect.any(Number)
    );
    expect(fillTextMock).toHaveBeenCalledWith(
      "Get cooking.",
      expect.any(Number),
      expect.any(Number)
    );
    expect(fillTextMock).toHaveBeenCalledWith(
      "Made with LinkDish · linkdish.ca",
      expect.any(Number),
      expect.any(Number)
    );
  });

  it("exports the share card as a PNG blob", async () => {
    const blob = await createShareCardBlob({
      sourceHost: "kitchen.example",
      title: "Sunday Soup"
    });

    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe("image/png");
  });
});
