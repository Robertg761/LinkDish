import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerRecipePhotoRoutes } from "./recipe-photo-routes.js";

const mocks = vi.hoisted(() => ({
  getAuthenticatedUser: vi.fn(),
  readRecipePhoto: vi.fn(),
  storeRecipePhoto: vi.fn()
}));

vi.mock("../auth/auth-service.js", () => ({ getAuthenticatedUser: mocks.getAuthenticatedUser }));
vi.mock("./recipe-photo-store.js", () => ({ readRecipePhoto: mocks.readRecipePhoto }));
vi.mock("./recipe-photos.js", async (load) => ({
  ...(await load<Record<string, unknown>>()),
  storeRecipePhoto: mocks.storeRecipePhoto
}));

const buildApp = () => {
  const app = Fastify();
  registerRecipePhotoRoutes(app);
  return app;
};

const upload = (dataUrl: string) => ({
  method: "POST" as const,
  payload: { dataUrl },
  url: "/image/photos"
});

afterEach(() => {
  vi.resetAllMocks();
});

describe("recipe photo routes (local API)", () => {
  it("stores an upload for the signed-in account", async () => {
    mocks.getAuthenticatedUser.mockResolvedValue({ user: { id: "user_cook" } });
    mocks.storeRecipePhoto.mockResolvedValue({ height: 1, path: "/image/photos/a.webp", width: 1 });

    const response = await buildApp().inject(upload("data:image/png;base64,abc"));

    expect(response.statusCode).toBe(201);
    expect(mocks.storeRecipePhoto).toHaveBeenCalledWith("user_cook", "data:image/png;base64,abc");
  });

  it("turns away an upload without an account", async () => {
    mocks.getAuthenticatedUser.mockResolvedValue(null);

    const response = await buildApp().inject(upload("data:image/png;base64,abc"));

    expect(response.statusCode).toBe(401);
  });

  it("refuses a file that isn't a JPEG, PNG or WebP", async () => {
    mocks.getAuthenticatedUser.mockResolvedValue({ user: { id: "user_cook" } });

    const response = await buildApp().inject(upload("data:image/svg+xml;base64,abc"));

    expect(response.statusCode).toBe(400);
    expect(mocks.storeRecipePhoto).not.toHaveBeenCalled();
  });

  it("serves a stored picture as WebP", async () => {
    mocks.readRecipePhoto.mockResolvedValue(Buffer.from("webp-bytes"));

    const response = await buildApp().inject({ url: "/image/photos/abc.webp" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("image/webp");
    expect(response.body).toBe("webp-bytes");
  });

  it("answers 404 for a picture that isn't there", async () => {
    mocks.readRecipePhoto.mockResolvedValue(null);

    const response = await buildApp().inject({ url: "/image/photos/missing.webp" });

    expect(response.statusCode).toBe(404);
  });
});
