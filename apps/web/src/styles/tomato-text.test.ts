import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

const cssFiles = (readdirSync(SRC_DIR, { recursive: true }) as string[])
  .filter((file) => file.endsWith(".css"))
  .map((file) => join(SRC_DIR, file));

/** Plain --color-tomato as a text color (not -ink, -soft or -hover). */
const TOMATO_TEXT = /(?:^|[\s;{])color:\s*var\(--color-tomato\)/u;

describe("tomato text", () => {
  it("styles small tomato text with --color-tomato-ink, which passes AA", () => {
    // --color-tomato is below 4.5:1 on the light surfaces; it stays for fills, icons and large
    // display type. A rule that sets a font size is styling text, so it must use the ink shade.
    const offenders: string[] = [];

    for (const file of cssFiles) {
      const css = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//gu, "");

      for (const rule of css.split("}")) {
        const [selector = "", body = ""] = rule.split("{").slice(-2);

        if (TOMATO_TEXT.test(body) && /(?:^|[\s;])font-size:/u.test(body)) {
          offenders.push(`${relative(SRC_DIR, file)}: ${selector.trim()}`);
        }
      }
    }

    expect(cssFiles.length).toBeGreaterThan(20);
    expect(offenders).toEqual([]);
  });
});
