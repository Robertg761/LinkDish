import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const requestUrlOf = (input: string | URL | Request): string =>
  typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

describe("provider monitoring", () => {
  it("sends the Gemini key in the x-goog-api-key header instead of the URL", async () => {
    vi.resetModules();
    vi.stubEnv("GEMINI_API_KEY", "gemini-secret-key");
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: requestUrlOf(input), init });
        return Promise.resolve(Response.json({ models: [{ name: "models/gemini-test" }] }));
      })
    );
    const { getAdminProviderLiveSnapshots } = await import("./provider-monitoring.js");

    const snapshots = await getAdminProviderLiveSnapshots();
    const geminiCall = calls.find(({ url }) =>
      url.startsWith("https://generativelanguage.googleapis.com/")
    );

    expect(snapshots.find((snapshot) => snapshot.id === "gemini")?.status).toBe("ok");
    expect(geminiCall).toBeDefined();
    expect(geminiCall?.url).not.toContain("gemini-secret-key");
    expect(geminiCall?.url).not.toContain("key=");
    expect(new Headers(geminiCall?.init?.headers).get("x-goog-api-key")).toBe(
      "gemini-secret-key"
    );
  });
});
