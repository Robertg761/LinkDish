import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({
  Platform: { OS: "android", select: (specifics: Record<string, unknown>) => specifics.android },
  Pressable: () => null,
  StyleSheet: { create: <T>(styles: T): T => styles, flatten: (style: unknown) => style },
  Text: () => null,
  TextInput: () => null,
  View: () => null
}));

const { appColors, appDarkColors, appPalettes, appShadows, appSpacing, getAppSerifFontFamily } =
  await import("./index.js");

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

  it("keeps the brand palette in sync with the web light theme", () => {
    // apps/web/src/styles/tokens.css (light): --color-primary, --color-canvas, --color-bg,
    // --color-surface, --color-ink, --color-ink-muted, --color-border, --color-primary-soft,
    // --color-tomato(-soft), --color-butter(-soft).
    expect(appColors).toMatchObject({
      accent: "#29443b",
      accentSoft: "#dde7df",
      background: "#f4efe7",
      border: "#ddd2c3",
      butter: "#e9bd5a",
      butterSoft: "#f7e9c8",
      canvas: "#fbf7f0",
      muted: "#6e685f",
      surface: "#fffdf8",
      text: "#1f211d",
      tomato: "#b95233",
      tomatoSoft: "#f3ddd3"
    });
  });
});

describe("dark palette", () => {
  it("defines every light token with hex or rgba colors only", () => {
    expect(Object.keys(appDarkColors).sort()).toEqual(Object.keys(appColors).sort());

    for (const [name, value] of Object.entries(appDarkColors)) {
      expect(`${name}:${value}`).toMatch(/:(?:#[0-9a-f]{3,8}|rgba?\(.+\))$/iu);
    }
  });

  it("uses warm charcoal surfaces and cream ink rather than pure black and white", () => {
    expect(appDarkColors.background).not.toBe("#000000");
    expect(appDarkColors.surface).not.toBe("#000000");
    expect(appDarkColors.text).not.toBe("#ffffff");
    expect(appPalettes.light).toBe(appColors);
    expect(appPalettes.dark).toBe(appDarkColors);
  });
});
