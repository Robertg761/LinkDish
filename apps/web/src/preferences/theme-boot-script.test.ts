import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { PREFERENCES_STORAGE_KEY, THEME_COLORS } from "./preferences-store";

/**
 * index.html carries a tiny inline script that applies the saved theme before first
 * paint. The Content-Security-Policy must allow it by hash, so changing the script
 * means updating this hash AND the `script-src` of apps/web/vercel.json and the
 * app host rule in the root vercel.json.
 */
const THEME_BOOT_SCRIPT_CSP_HASH = "sha256-Gx75g3P/94t2dubzu/zEVZUhlNzdIAiLifLVj8l4WJA=";

const indexHtml = readFileSync(resolve(__dirname, "../../index.html"), "utf8");
const inlineScript = /<script>([\s\S]*?)<\/script>/.exec(indexHtml)?.[1] ?? "";

describe("theme boot script in index.html", () => {
  it("reads the same storage key and colors as the preferences store", () => {
    expect(inlineScript).toContain(PREFERENCES_STORAGE_KEY);
    expect(inlineScript).toContain(THEME_COLORS.dark);
    expect(inlineScript).toContain(THEME_COLORS.light);
    expect(indexHtml).toContain(
      `content="${THEME_COLORS.light}" media="(prefers-color-scheme: light)"`
    );
    expect(indexHtml).toContain(
      `content="${THEME_COLORS.dark}" media="(prefers-color-scheme: dark)"`
    );
  });

  it("matches the CSP hash that deployments must allow", () => {
    const hash = `sha256-${createHash("sha256").update(inlineScript).digest("base64")}`;

    expect(hash).toBe(THEME_BOOT_SCRIPT_CSP_HASH);
  });

  it("no longer loads the icon webfont from a CDN or a duplicate manifest", () => {
    expect(indexHtml).not.toContain("materialdesignicons");
    expect(indexHtml).not.toContain('rel="manifest"');
  });
});
