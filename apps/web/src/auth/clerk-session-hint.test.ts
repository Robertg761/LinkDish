import { describe, expect, it } from "vitest";

import { hasClerkSessionHint } from "./clerk-session-hint";

describe("hasClerkSessionHint", () => {
  it("reads Clerk's client_uat cookie, including suffixed names", () => {
    expect(hasClerkSessionHint("")).toBe(false);
    expect(hasClerkSessionHint("theme=dark; __client_uat=0")).toBe(false);
    expect(hasClerkSessionHint("__client_uat=")).toBe(false);
    expect(hasClerkSessionHint("theme=dark; __client_uat=1790000000")).toBe(true);
    expect(hasClerkSessionHint("__client_uat_AbC12=1790000000")).toBe(true);
    expect(hasClerkSessionHint("my__client_uat=1790000000")).toBe(false);
  });
});
