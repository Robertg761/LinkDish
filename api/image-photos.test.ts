import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  checkPublicEndpointRateLimit: vi.fn(),
  getAuthenticatedUser: vi.fn(),
  readRecipePhoto: vi.fn(),
  storeRecipePhoto: vi.fn()
}));

vi.mock("../services/extractor-api/src/modules/auth/auth-service.js", () => ({
  getAuthenticatedUser: mocks.getAuthenticatedUser
}));
vi.mock("../services/extractor-api/src/modules/rate-limit/enforce-rate-limit.js", async (load) => ({
  ...(await load<Record<string, unknown>>()),
  checkPublicEndpointRateLimit: mocks.checkPublicEndpointRateLimit
}));
vi.mock("../services/extractor-api/src/modules/image/recipe-photo-store.js", async (load) => ({
  ...(await load<Record<string, unknown>>()),
  readRecipePhoto: mocks.readRecipePhoto
}));
vi.mock("../services/extractor-api/src/modules/image/recipe-photos.js", async (load) => ({
  ...(await load<Record<string, unknown>>()),
  storeRecipePhoto: mocks.storeRecipePhoto
}));

const DATA_URL = "data:image/jpeg;base64,abc123";
const STORED = { height: 480, path: `/image/photos/${"a".repeat(32)}.webp`, width: 640 };

const upload = (body: unknown = { dataUrl: DATA_URL }) =>
  new Request("https://api.linkdish.ca/image/photos", {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", origin: "https://app.linkdish.ca" },
    method: "POST"
  });

const fetchPhoto = (file: string) =>
  new Request(`https://api.linkdish.ca/api/image?photo=${file}`, {
    headers: { origin: "https://app.linkdish.ca" }
  });

const signedIn = () => {
  mocks.getAuthenticatedUser.mockResolvedValue({ user: { id: "user_cook" } });
  mocks.checkPublicEndpointRateLimit.mockResolvedValue({ allowed: true, headers: {} });
};

afterEach(() => {
  vi.resetAllMocks();
});

describe("Vercel recipe photo routes", () => {
  it("stores an upload for the signed-in account", async () => {
    signedIn();
    mocks.storeRecipePhoto.mockResolvedValue(STORED);
    const { POST } = await import("./image.js");

    const response = await POST(upload());

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual(STORED);
    expect(mocks.storeRecipePhoto).toHaveBeenCalledWith("user_cook", DATA_URL);
  });

  it("turns away an upload without an account", async () => {
    mocks.getAuthenticatedUser.mockResolvedValue(null);
    const { POST } = await import("./image.js");

    expect((await POST(upload())).status).toBe(401);
    expect(mocks.storeRecipePhoto).not.toHaveBeenCalled();
  });

  it("limits how many pictures arrive at once", async () => {
    signedIn();
    mocks.checkPublicEndpointRateLimit.mockResolvedValue({ allowed: false, headers: {} });
    const { POST } = await import("./image.js");

    expect((await POST(upload())).status).toBe(429);
    expect(mocks.storeRecipePhoto).not.toHaveBeenCalled();
  });

  it("refuses anything but a picture's data URL", async () => {
    signedIn();
    const { POST } = await import("./image.js");

    for (const body of [{ dataUrl: "data:image/svg+xml;base64,abc" }, {}, null]) {
      expect((await POST(upload(body))).status).toBe(400);
    }
  });

  it("passes on the reason a picture was refused", async () => {
    signedIn();
    const { RecipePhotoError } =
      await import("../services/extractor-api/src/modules/image/recipe-photos.js");
    mocks.storeRecipePhoto.mockRejectedValue(new RecipePhotoError("Too many.", 409));
    const { POST } = await import("./image.js");

    const response = await POST(upload());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ message: "Too many." });
  });

  it("keeps the store's details out of an unexpected failure", async () => {
    signedIn();
    mocks.storeRecipePhoto.mockRejectedValue(new Error("redis://internal-host refused"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { POST } = await import("./image.js");

    const response = await POST(upload());

    expect(response.status).toBe(500);
    await expect(response.text()).resolves.not.toContain("internal-host");
  });

  it("serves a stored picture to anyone, without a rate limit, briefly cached", async () => {
    mocks.readRecipePhoto.mockResolvedValue(Buffer.from("webp-bytes"));
    const { GET } = await import("./image.js");

    const response = await GET(fetchPhoto(`${"a".repeat(32)}.webp`));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/webp");
    expect(response.headers.get("cdn-cache-control")).toBe("public, s-maxage=86400");
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe("webp-bytes");
    expect(mocks.checkPublicEndpointRateLimit).not.toHaveBeenCalled();
  });

  it("answers 404, uncached, for a picture that isn't there", async () => {
    mocks.readRecipePhoto.mockResolvedValue(null);
    const { GET } = await import("./image.js");

    const response = await GET(fetchPhoto("missing.webp"));

    expect(response.status).toBe(404);
    expect(response.headers.get("cdn-cache-control")).toBeNull();
  });
});
