import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { analyzeDist, checkBudgets, formatReport, readHtmlAssets } from "./bundle-size";

const HTML = `<!doctype html>
<html>
  <head>
    <script>(function () { /* theme */ })();</script>
    <link rel="preload" href="/fonts/Fraunces-Bold.woff2" as="font" type="font/woff2" crossorigin />
    <script type="module" crossorigin src="/assets/index-abc.js"></script>
    <link rel="stylesheet" crossorigin href="/assets/index-abc.css">
    <link crossorigin="" fetchpriority="low" href="/assets/LibraryPage-def.js" rel="modulepreload">
    <link crossorigin="" href="/assets/app-core-ghi.js" rel="modulepreload">
    <link as="style" crossorigin="" href="/assets/LibraryPage-def.css" rel="preload">
    <link rel="manifest" href="/manifest.webmanifest">
  </head>
  <body><div id="root"></div></body>
</html>`;

let distDir: string | null = null;

const makeDist = (files: Record<string, string>) => {
  distDir = mkdtempSync(join(tmpdir(), "linkdish-dist-"));
  mkdirSync(join(distDir, "assets"));

  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(distDir, name), content);
  }

  return distDir;
};

/** Incompressible-ish content of a given size, so gzip sizes are predictable. */
const noise = (bytes: number, seed = 1) => {
  let state = seed;
  let text = "";

  while (text.length < bytes) {
    state = (state * 1103515245 + 12345) % 2 ** 31;
    text += state.toString(36);
  }

  return text.slice(0, bytes);
};

afterEach(() => {
  if (distDir) {
    rmSync(distDir, { force: true, recursive: true });
    distDir = null;
  }
});

describe("bundle budget", () => {
  it("reads the entry, preloaded chunks and stylesheets from index.html", () => {
    expect(readHtmlAssets(HTML)).toEqual({
      entry: "assets/index-abc.js",
      preloadedScripts: ["assets/LibraryPage-def.js", "assets/app-core-ghi.js"],
      preloadedStyles: ["assets/LibraryPage-def.css"],
      stylesheets: ["assets/index-abc.css"]
    });
  });

  it("passes a small build and fails an entry over budget", () => {
    const dir = makeDist({
      "assets/LibraryPage-def.css": ".library{}",
      "assets/LibraryPage-def.js": "export const page = 1;",
      "assets/app-core-ghi.js": "export const core = 1;",
      "assets/index-abc.css": "body{}",
      "assets/index-abc.js": noise(20_000),
      "index.html": HTML
    });
    const report = analyzeDist(dir);

    expect(report.entry.rawBytes).toBe(20_000);
    expect(report.landingScripts.map((size) => size.file)).toEqual([
      "assets/LibraryPage-def.js",
      "assets/app-core-ghi.js"
    ]);
    expect(checkBudgets(report).every((check) => check.ok)).toBe(true);

    const tight = checkBudgets(report, { entryJsKb: 1, landingCssKb: 24, landingJsKb: 150 });
    expect(tight.find((check) => check.name.startsWith("Entry"))?.ok).toBe(false);
    expect(formatReport(report, tight)).toContain("OVER Entry JS (gzip)");
  });

  it("counts the preloaded chunks in the landing total", () => {
    const dir = makeDist({
      "assets/LibraryPage-def.css": "",
      "assets/LibraryPage-def.js": noise(4_000, 2),
      "assets/app-core-ghi.js": noise(4_000, 3),
      "assets/index-abc.css": "",
      "assets/index-abc.js": noise(4_000, 4),
      "index.html": HTML
    });
    const report = analyzeDist(dir);
    const [, landing] = checkBudgets(report);
    const expected =
      report.entry.gzipBytes +
      report.landingScripts.reduce((total, size) => total + size.gzipBytes, 0);

    expect(landing?.actualKb).toBeCloseTo(expected / 1000, 1);
  });
});
