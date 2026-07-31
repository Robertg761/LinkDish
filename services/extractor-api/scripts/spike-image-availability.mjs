#!/usr/bin/env node
/**
 * Stage 0.2 spike: measure how often a usable recipe image is available.
 *
 * Capture chain (first hit wins): JSON-LD image -> og:image -> twitter:image
 * -> largest plausible content <img>. YouTube entries count as thumbnail-API
 * hits (deterministic i.ytimg.com URL derived from the video id).
 *
 * Modes:
 *   node scripts/spike-image-availability.mjs --fixtures
 *   node scripts/spike-image-availability.mjs --live ../../docs/live-canary-manifest.json [--limit N]
 *
 * Live mode uses a plain fetch with a browser UA and 10s timeout. Sites that
 * block plain fetches are reported separately: the production extractor has a
 * richer fetch pipeline (headless chromium fallback), so plain-fetch results
 * are a LOWER bound on availability.
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as cheerio from "cheerio";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(here, "../src/modules/extract/__fixtures__");

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const looksLikeChrome = (src) =>
  /logo|icon|sprite|avatar|badge|pixel|spacer|\.svg(\?|$)/iu.test(src);

const firstImageFromJsonLdNode = (node) => {
  if (!node || typeof node !== "object") return null;
  const nodes = Array.isArray(node) ? node : [node];
  for (const item of nodes) {
    if (!item || typeof item !== "object") continue;
    if (item["@graph"]) {
      const hit = firstImageFromJsonLdNode(item["@graph"]);
      if (hit) return hit;
    }
    const type = Array.isArray(item["@type"]) ? item["@type"].join(",") : String(item["@type"] ?? "");
    if (!/Recipe|Article|NewsArticle|BlogPosting|VideoObject/iu.test(type)) continue;
    const image = item.image;
    if (!image) continue;
    if (typeof image === "string") return image;
    if (Array.isArray(image)) {
      const first = image[0];
      if (typeof first === "string") return first;
      if (first && typeof first === "object" && typeof first.url === "string") return first.url;
    }
    if (typeof image === "object" && typeof image.url === "string") return image.url;
  }
  return null;
};

export const captureImage = (html) => {
  const $ = cheerio.load(html);

  for (const el of $('script[type="application/ld+json"]').toArray()) {
    try {
      const parsed = JSON.parse($(el).text());
      const hit = firstImageFromJsonLdNode(parsed);
      if (hit) return { source: "jsonld", url: hit };
    } catch {
      // malformed JSON-LD blocks are common in the wild; skip
    }
  }

  const og =
    $('meta[property="og:image:secure_url"]').attr("content") ??
    $('meta[property="og:image"]').attr("content") ??
    $('meta[name="og:image"]').attr("content");
  if (og) return { source: "og", url: og };

  const tw =
    $('meta[name="twitter:image"]').attr("content") ??
    $('meta[name="twitter:image:src"]').attr("content");
  if (tw) return { source: "twitter", url: tw };

  let best = null;
  for (const el of $("img[src]").toArray()) {
    const src = $(el).attr("src") ?? "";
    if (!src || src.startsWith("data:") || looksLikeChrome(src)) continue;
    const w = Number.parseInt($(el).attr("width") ?? "0", 10) || 0;
    const h = Number.parseInt($(el).attr("height") ?? "0", 10) || 0;
    const area = w * h;
    if (!best || area > best.area) best = { src, area };
  }
  if (best && (best.area >= 40000 || best.area === 0)) {
    return { source: "content", url: best.src };
  }
  return null;
};

const youtubeThumb = (url) => {
  const match = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]{6,})/u);
  return match ? `https://i.ytimg.com/vi/${match[1]}/hqdefault.jpg` : null;
};

const tally = (rows) => {
  const bySource = {};
  let hits = 0;
  for (const row of rows) {
    if (row.image) {
      hits += 1;
      bySource[row.image.source] = (bySource[row.image.source] ?? 0) + 1;
    }
  }
  return { total: rows.length, hits, rate: rows.length ? hits / rows.length : 0, bySource };
};

const printGroup = (label, rows) => {
  const t = tally(rows);
  const pct = (t.rate * 100).toFixed(0);
  console.log(`\n${label}: ${t.hits}/${t.total} (${pct}%)  by-source=${JSON.stringify(t.bySource)}`);
  for (const row of rows) {
    const s = row.image ? `${row.image.source.padEnd(7)} ${row.image.url.slice(0, 80)}` : row.error ? `ERROR   ${row.error}` : "none";
    console.log(`  ${row.id.padEnd(52).slice(0, 52)} ${s}`);
  }
};

const runFixtures = async () => {
  const files = (await readdir(FIXTURES_DIR)).filter((f) => f.endsWith(".html"));
  const rows = [];
  for (const file of files) {
    const html = await readFile(path.join(FIXTURES_DIR, file), "utf8");
    rows.push({ id: file, kind: "fixture", image: captureImage(html) });
  }
  printGroup("FIXTURES (synthetic parser corpus — small, not representative)", rows);
};

const runLive = async (manifestPath, limit) => {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const entries = limit ? manifest.slice(0, limit) : manifest;
  const rows = [];
  for (const entry of entries) {
    if (entry.kind === "youtube") {
      const url = youtubeThumb(entry.url);
      rows.push({ id: entry.id, kind: entry.kind, image: url ? { source: "youtube-thumb", url } : null });
      continue;
    }
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      const response = await fetch(entry.url, {
        headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml" },
        redirect: "follow",
        signal: controller.signal
      });
      clearTimeout(timer);
      if (!response.ok) {
        rows.push({ id: entry.id, kind: entry.kind, image: null, error: `HTTP ${response.status}` });
        continue;
      }
      const html = await response.text();
      rows.push({ id: entry.id, kind: entry.kind, image: captureImage(html) });
    } catch (error) {
      rows.push({ id: entry.id, kind: entry.kind, image: null, error: error.name ?? String(error) });
    }
  }
  const kinds = [...new Set(rows.map((r) => r.kind))];
  for (const kind of kinds) {
    printGroup(`LIVE ${kind}`, rows.filter((r) => r.kind === kind));
  }
  const blocked = rows.filter((r) => r.error);
  const reachable = rows.filter((r) => !r.error);
  const t = tally(rows);
  const tReachable = tally(reachable);
  console.log(`\nOVERALL: ${t.hits}/${t.total} (${(t.rate * 100).toFixed(0)}%)`);
  console.log(
    `REACHABLE-ONLY (production fetch pipeline would recover most blocked fetches): ${tReachable.hits}/${tReachable.total} (${(tReachable.rate * 100).toFixed(0)}%), blocked/plain-fetch-failed: ${blocked.length}`
  );
};

const main = async () => {
  const args = process.argv.slice(2);
  if (args.includes("--fixtures")) {
    await runFixtures();
    return;
  }
  const liveIdx = args.indexOf("--live");
  if (liveIdx !== -1 && args[liveIdx + 1]) {
    const limitIdx = args.indexOf("--limit");
    const limit = limitIdx !== -1 ? Number.parseInt(args[limitIdx + 1], 10) : 0;
    await runLive(path.resolve(args[liveIdx + 1]), limit);
    return;
  }
  console.log("usage: spike-image-availability.mjs --fixtures | --live <manifest.json> [--limit N]");
  process.exitCode = 1;
};

await main();
