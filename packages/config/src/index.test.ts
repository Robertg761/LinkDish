import { z } from "zod";
import { describe, expect, it } from "vitest";

import { readEnv, stringBooleanSchema } from "./index.js";

describe("readEnv", () => {
  it("parses and keeps the declared environment variables", () => {
    const parsed = readEnv(
      {
        LINKDISH_API_BASE_URL: z.string().url(),
        LINKDISH_FEATURE_FLAG: stringBooleanSchema
      },
      {
        LINKDISH_API_BASE_URL: "https://api.linkdish.ca",
        LINKDISH_FEATURE_FLAG: "true",
        UNRELATED: "ignored"
      }
    );

    expect(parsed.LINKDISH_API_BASE_URL).toBe("https://api.linkdish.ca");
    expect(parsed.LINKDISH_FEATURE_FLAG).toBe(true);
  });

  it("throws when a declared variable is missing or invalid", () => {
    expect(() => readEnv({ LINKDISH_API_BASE_URL: z.string().url() }, {})).toThrow();
    expect(() =>
      readEnv({ LINKDISH_API_BASE_URL: z.string().url() }, { LINKDISH_API_BASE_URL: "nope" })
    ).toThrow();
  });
});

describe("stringBooleanSchema", () => {
  it("maps only the exact boolean strings", () => {
    expect(stringBooleanSchema.parse("true")).toBe(true);
    expect(stringBooleanSchema.parse("false")).toBe(false);
    expect(stringBooleanSchema.safeParse("TRUE").success).toBe(false);
    expect(stringBooleanSchema.safeParse("1").success).toBe(false);
  });
});
