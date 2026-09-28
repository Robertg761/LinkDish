/**
 * Bundle budget for the web app: `pnpm --filter @linkdish/web size` (after a build).
 *
 * Reads dist/index.html to find what a first visit to / downloads before the page can render —
 * the entry script, the scripts and stylesheets preloaded for the Cookbook, and the blocking
 * stylesheet — and checks their gzip sizes against the budgets below. Exits 1 when over budget,
 * so CI can run it after `pnpm --filter @linkdish/web build`.
 *
 * Node 22 runs this file directly (type stripping); keep it to erasable TypeScript syntax.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

export interface BundleBudgets {
  /** gzip KB of the entry chunk (the app shell). */
  entryJsKb: number;
  /** gzip KB of every script a cold visit to / needs: the entry plus the preloaded Cookbook. */
  landingJsKb: number;
  /** gzip KB of render-blocking CSS plus the Cookbook's preloaded stylesheets. */
  landingCssKb: number;
}

/** Baseline before the overhaul: 130.7 KB entry. The shell alone is ~101 KB (Sept 2026). */
export const BUNDLE_BUDGETS: BundleBudgets = {
  entryJsKb: 115,
  landingJsKb: 150,
  landingCssKb: 24
};

export interface HtmlAssets {
  entry: string | null;
  preloadedScripts: string[];
  stylesheets: string[];
  preloadedStyles: string[];
}

const attribute = (tag: string, name: string): string | null => {
  const match = new RegExp(`\\s${name}=(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "iu").exec(tag);
  return match ? (match[1] ?? match[2] ?? match[3] ?? "") : null;
};

/** The assets index.html asks for up front, as paths relative to the site root. */
export const readHtmlAssets = (html: string): HtmlAssets => {
  const assets: HtmlAssets = {
    entry: null,
    preloadedScripts: [],
    preloadedStyles: [],
    stylesheets: []
  };
  const strip = (href: string) => href.replace(/^\//u, "");

  for (const [tag] of html.matchAll(/<script\b[^>]*>/giu)) {
    const src = attribute(tag, "src");

    if (src && attribute(tag, "type") === "module" && !assets.entry) {
      assets.entry = strip(src);
    }
  }

  for (const [tag] of html.matchAll(/<link\b[^>]*>/giu)) {
    const rel = attribute(tag, "rel")?.toLowerCase();
    const href = attribute(tag, "href");

    if (!href || !href.includes("/assets/")) {
      continue;
    }

    if (rel === "modulepreload") {
      assets.preloadedScripts.push(strip(href));
    } else if (rel === "stylesheet") {
      assets.stylesheets.push(strip(href));
    } else if (rel === "preload" && attribute(tag, "as") === "style") {
      assets.preloadedStyles.push(strip(href));
    }
  }

  return assets;
};

export interface AssetSize {
  file: string;
  rawBytes: number;
  gzipBytes: number;
}

export const measureAsset = (distDir: string, file: string): AssetSize => {
  const content = readFileSync(join(distDir, file));
  return { file, gzipBytes: gzipSync(content, { level: 9 }).length, rawBytes: content.length };
};

export interface BundleReport {
  entry: AssetSize;
  landingScripts: AssetSize[];
  landingStyles: AssetSize[];
}

export const analyzeDist = (distDir: string): BundleReport => {
  const assets = readHtmlAssets(readFileSync(join(distDir, "index.html"), "utf8"));

  if (!assets.entry) {
    throw new Error("No <script type=module> entry in index.html.");
  }

  return {
    entry: measureAsset(distDir, assets.entry),
    landingScripts: assets.preloadedScripts.map((file) => measureAsset(distDir, file)),
    landingStyles: [...assets.stylesheets, ...assets.preloadedStyles].map((file) =>
      measureAsset(distDir, file)
    )
  };
};

const kb = (bytes: number): number => Math.round((bytes / 1000) * 100) / 100;
const sum = (sizes: AssetSize[], key: "gzipBytes" | "rawBytes") =>
  sizes.reduce((total, size) => total + size[key], 0);

export interface BudgetCheck {
  name: string;
  actualKb: number;
  budgetKb: number;
  ok: boolean;
}

export const checkBudgets = (
  report: BundleReport,
  budgets: BundleBudgets = BUNDLE_BUDGETS
): BudgetCheck[] => {
  const checks: Array<[string, number, number]> = [
    ["Entry JS (gzip)", report.entry.gzipBytes, budgets.entryJsKb],
    [
      "Landing JS for / (gzip)",
      report.entry.gzipBytes + sum(report.landingScripts, "gzipBytes"),
      budgets.landingJsKb
    ],
    ["Landing CSS for / (gzip)", sum(report.landingStyles, "gzipBytes"), budgets.landingCssKb]
  ];

  return checks.map(([name, bytes, budgetKb]) => ({
    actualKb: kb(bytes),
    budgetKb,
    name,
    ok: kb(bytes) <= budgetKb
  }));
};

export const formatReport = (report: BundleReport, checks: BudgetCheck[]): string => {
  const row = (size: AssetSize) =>
    `  ${size.file.padEnd(48)} ${String(kb(size.rawBytes)).padStart(9)} KB  ${String(kb(size.gzipBytes)).padStart(8)} KB gz`;
  const lines = [
    "Entry",
    row(report.entry),
    "Preloaded for /",
    ...report.landingScripts.map(row),
    "Stylesheets for /",
    ...report.landingStyles.map(row),
    "",
    ...checks.map(
      (check) =>
        `${check.ok ? "ok  " : "OVER"} ${check.name.padEnd(28)} ${String(check.actualKb).padStart(8)} KB / ${check.budgetKb} KB`
    )
  ];

  return lines.join("\n");
};

const isMain = (): boolean => {
  const script = process.argv[1];
  return Boolean(script) && import.meta.url === pathToFileURL(resolve(script ?? "")).href;
};

if (isMain()) {
  const distDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist");

  if (!existsSync(join(distDir, "index.html"))) {
    console.error("No build found. Run `pnpm --filter @linkdish/web build` first.");
    process.exit(2);
  }

  const report = analyzeDist(distDir);
  const checks = checkBudgets(report);
  console.log(formatReport(report, checks));

  if (checks.some((check) => !check.ok)) {
    console.error("\nBundle budget exceeded. See apps/web/scripts/bundle-size.ts.");
    process.exit(1);
  }
}
