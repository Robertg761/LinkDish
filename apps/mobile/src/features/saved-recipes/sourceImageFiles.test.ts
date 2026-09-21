import { beforeEach, describe, expect, it, vi } from "vitest";

const fileSystemMocks = vi.hoisted(() => ({
  createdDirectories: [] as string[],
  failWritesFor: null as string | null,
  writes: [] as Array<{ content: string; encoding: string | undefined; uri: string }>
}));

vi.mock("expo-file-system", () => {
  class Directory {
    public exists = false;

    public uri: string;

    public constructor(...parts: Array<{ uri: string } | string>) {
      this.uri = parts
        .map((part) => (typeof part === "string" ? part : part.uri).replace(/\/+$/u, ""))
        .join("/");
    }

    public create() {
      this.exists = true;
      fileSystemMocks.createdDirectories.push(this.uri);
    }
  }

  class File {
    public uri: string;

    public constructor(...parts: Array<{ uri: string } | string>) {
      this.uri = parts
        .map((part) => (typeof part === "string" ? part : part.uri).replace(/\/+$/u, ""))
        .join("/");
    }

    public create() {
      // no-op in tests
    }

    public write(content: string, options?: { encoding?: string }) {
      if (fileSystemMocks.failWritesFor && this.uri.includes(fileSystemMocks.failWritesFor)) {
        throw new Error("No space left on device");
      }

      fileSystemMocks.writes.push({
        content,
        encoding: options?.encoding,
        uri: this.uri
      });
    }
  }

  return {
    Directory,
    File,
    Paths: {
      document: { uri: "file:///documents/" }
    }
  };
});

import { persistRecipeSourceImages } from "./sourceImageFiles";

describe("recipe scan image files", () => {
  beforeEach(() => {
    fileSystemMocks.createdDirectories.splice(0);
    fileSystemMocks.writes.splice(0);
    fileSystemMocks.failWritesFor = null;
    vi.restoreAllMocks();
  });

  it("writes base64 scans to the filesystem and returns file uris", async () => {
    const images = await persistRecipeSourceImages("saved-1", [
      { mimeType: "image/jpeg", uri: "data:image/jpeg;base64,AAAABBBB" }
    ]);

    expect(fileSystemMocks.writes).toHaveLength(1);
    expect(fileSystemMocks.writes[0]?.content).toBe("AAAABBBB");
    expect(fileSystemMocks.writes[0]?.encoding).toBe("base64");
    expect(images).toHaveLength(1);
    expect(images?.[0]?.mimeType).toBe("image/jpeg");
    expect(images?.[0]?.uri.startsWith("file:///documents/")).toBe(true);
    expect(images?.[0]?.uri).not.toContain("base64");
    expect(images?.[0]?.uri.endsWith(".jpg")).toBe(true);
  });

  it("leaves already persisted scans untouched", async () => {
    const stored = [
      { mimeType: "image/png" as const, uri: "file:///documents/recipe-scans/saved-1-0.png" }
    ];

    await expect(persistRecipeSourceImages("saved-1", stored)).resolves.toEqual(stored);
    expect(fileSystemMocks.writes).toHaveLength(0);
  });

  it("keeps the rest of a scan set when one write fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    fileSystemMocks.failWritesFor = "saved-2-0";

    const images = await persistRecipeSourceImages("saved-2", [
      { mimeType: "image/jpeg", uri: "data:image/jpeg;base64,FIRST" },
      { mimeType: "image/png", uri: "data:image/png;base64,SECOND" }
    ]);

    expect(images).toHaveLength(1);
    expect(images?.[0]?.uri.endsWith(".png")).toBe(true);
    expect(fileSystemMocks.writes).toHaveLength(1);
  });

  it("returns undefined when there is nothing to persist", async () => {
    await expect(persistRecipeSourceImages("saved-3", undefined)).resolves.toBeUndefined();
    await expect(persistRecipeSourceImages("saved-3", [])).resolves.toBeUndefined();
  });
});
