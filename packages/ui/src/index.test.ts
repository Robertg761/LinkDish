import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({
  Platform: { OS: "android", select: (specifics: Record<string, unknown>) => specifics.android },
  Pressable: () => null,
  StyleSheet: { create: <T>(styles: T): T => styles, flatten: (style: unknown) => style },
  Text: () => null,
  TextInput: () => null,
  View: () => null
}));

const { appColors, appShadows, appSpacing, getAppSerifFontFamily } = await import("./index.js");

describe("getAppSerifFontFamily", () => {
  it("returns the Fraunces voice when the custom font is loaded", () => {
    expect(getAppSerifFontFamily("bold")).toBe("Fraunces-Bold");
    expect(getAppSerifFontFamily("italic")).toBe("Fraunces-SemiBoldItalic");
    expect(getAppSerifFontFamily()).toBe("Fraunces-SemiBold");
  });

  it("falls back to a platform serif when the custom font is unavailable", () => {
    expect(getAppSerifFontFamily("bold", false)).toBe("serif");
  });
});

describe("design tokens", () => {
  it("exposes hex or rgba colors only", () => {
    for (const [name, value] of Object.entries(appColors)) {
      expect(`${name}:${value}`).toMatch(/:(?:#[0-9a-f]{3,8}|rgba?\(.+\))$/iu);
    }
  });

  it("exposes a non-negative numeric spacing scale", () => {
    const values: unknown[] = Object.values(appSpacing);

    expect(values.length).toBeGreaterThan(0);
    for (const value of values) {
      expect(typeof value).toBe("number");
      expect(value as number).toBeGreaterThanOrEqual(0);
    }
  });

  it("exposes shadow tokens", () => {
    expect(Object.keys(appShadows).length).toBeGreaterThan(0);
  });
});
