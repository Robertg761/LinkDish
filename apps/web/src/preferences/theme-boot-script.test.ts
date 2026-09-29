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

/**
 * Bodies of the inline (no `src`) scripts in an HTML page. Tags match the way browsers read
 * them: any case, attributes on the start tag, whitespace or junk before the end tag's ">".
 */
const readInlineScripts = (html: string): string[] =>
  [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\b[^>]*>/giu)]
    .filter((match) => !/\ssrc\s*=/iu.test(match[1] ?? ""))
    .map((match) => match[2] ?? "");

const indexHtml = readFileSync(resolve(__dirname, "../../index.html"), "utf8");
const inlineScripts = readInlineScripts(indexHtml);
const inlineScript = inlineScripts[0] ?? "";

describe("theme boot script in index.html", () => {
  it("is the page's only inline script, since the CSP allows exactly one hash", () => {
    expect(inlineScripts).toHaveLength(1);
  });

  it("finds inline scripts in any case and with loose end tags", () => {
    expect(
      readInlineScripts(
        [
          "<SCRIPT>upper()</SCRIPT>",
          '<script type="module" src="/src/main.tsx"></script>',
          "<Script nonce=x>mixed()</script >",
          '<script>\nlines()\n</script\t\n foo="bar">'
        ].join("")
      )
    ).toEqual(["upper()", "mixed()", "\nlines()\n"]);
  });

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
