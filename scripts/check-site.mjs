import { access, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const siteRoot = path.join(repositoryRoot, "site");
const siteOrigin = "https://linkdish.ca";
const errors = [];

const requiredFiles = [
  ".nojekyll",
  "404.html",
  "CNAME",
  "analytics.js",
  "apple-touch-icon.png",
  "base.css",
  "favicon.ico",
  "index.html",
  "info.css",
  "invite/index.html",
  "marketing.css",
  "meal-planner-and-grocery-list/index.html",
  "paprika-alternative/index.html",
  "privacy/index.html",
  "recipe-saver-app/index.html",
  "robots.txt",
  "save-recipes-from-websites/index.html",
  "save-recipes-from-youtube/index.html",
  "scan-recipes-from-photos/index.html",
  "site.js",
  "sitemap.xml",
  "support/index.html"
];

// Link previews (WhatsApp in particular) drop og:image files above roughly 300 KB.
const maxSocialImageBytes = 300 * 1024;

const exists = async (filePath) => {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
};

const collectFiles = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      return entry.isDirectory() ? collectFiles(entryPath) : [entryPath];
    })
  );

  return nested.flat();
};

const relativeSitePath = (filePath) => path.relative(siteRoot, filePath).split(path.sep).join("/");

const pageUrlForFile = (filePath) => {
  const relativePath = relativeSitePath(filePath);
  const pagePath = relativePath === "index.html" ? "/" : `/${relativePath}`;
  return new URL(pagePath, siteOrigin);
};

const localPathForUrl = (url) => {
  const decodedPath = decodeURIComponent(url.pathname);
  const relativePath = decodedPath.endsWith("/") ? `${decodedPath}index.html` : decodedPath;
  const localPath = path.resolve(siteRoot, `.${relativePath}`);

  if (localPath !== siteRoot && !localPath.startsWith(`${siteRoot}${path.sep}`)) {
    return null;
  }

  return localPath;
};

const readPngDimensions = async (filePath) => {
  const image = await readFile(filePath);
  const pngSignature = "89504e470d0a1a0a";

  if (image.length < 24 || image.subarray(0, 8).toString("hex") !== pngSignature) {
    return null;
  }

  return {
    height: image.readUInt32BE(20),
    width: image.readUInt32BE(16)
  };
};

for (const relativePath of requiredFiles) {
  if (!(await exists(path.join(siteRoot, relativePath)))) {
    errors.push(`Missing required site file: ${relativePath}`);
  }
}

const cname = (await readFile(path.join(siteRoot, "CNAME"), "utf8")).trim();

if (cname !== "linkdish.ca") {
  errors.push(`CNAME must contain only linkdish.ca; found ${JSON.stringify(cname)}`);
}

const files = await collectFiles(siteRoot);
const textFiles = files.filter((filePath) => /\.(?:css|html|js|md|txt|xml)$/u.test(filePath));

for (const filePath of textFiles) {
  const content = await readFile(filePath, "utf8");

  if (/robertgordon761@gmail\.com/iu.test(content)) {
    errors.push(`${relativeSitePath(filePath)} contains a personal email address`);
  }

  if (/linkdish\.xyz/iu.test(content)) {
    errors.push(`${relativeSitePath(filePath)} contains the retired linkdish.xyz domain`);
  }
}

const htmlFiles = files.filter((filePath) => filePath.endsWith(".html"));
const htmlByPath = new Map(
  await Promise.all(htmlFiles.map(async (filePath) => [filePath, await readFile(filePath, "utf8")]))
);

const decodeEntities = (text) =>
  text
    .replaceAll("&nbsp;", " ")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");

const visibleText = (html) =>
  decodeEntities(
    html
      .replace(/<script\b[\s\S]*?<\/script>/gu, " ")
      .replace(/<style\b[\s\S]*?<\/style>/gu, " ")
      .replace(/<[^>]+>/gu, " ")
  )
    .replace(/\s+/gu, " ")
    .replace(/\s([.,;:!?)])/gu, "$1");

// srcset="a.avif 360w, b.avif 720w" (also imagesrcset on preload links) -> ["a.avif", "b.avif"]
const srcsetReferences = (html) =>
  [...html.matchAll(/\b(?:srcset|imagesrcset)="([^"]*)"/gu)].flatMap((match) =>
    match[1]
      .split(",")
      .map((candidate) => candidate.trim().split(/\s+/u)[0])
      .filter(Boolean)
  );

const attribute = (tag, name) => tag.match(new RegExp(`\\s${name}="([^"]*)"`, "u"))?.[1];

for (const [filePath, html] of htmlByPath) {
  const fileLabel = relativeSitePath(filePath);
  const pageUrl = pageUrlForFile(filePath);
  const references = [
    ...[...html.matchAll(/\b(?:href|src)="([^"]+)"/gu)].map((match) => match[1]),
    ...srcsetReferences(html)
  ];

  for (const tag of html.match(/<img\b[^>]*>/gu) || []) {
    for (const name of ["alt", "width", "height"]) {
      if (attribute(tag, name) === undefined) {
        errors.push(`${fileLabel} has an <img> without ${name}: ${tag.slice(0, 120)}`);
      }
    }
  }

  for (const tag of html.match(/<source\b[^>]*>/gu) || []) {
    if (!attribute(tag, "srcset") || !attribute(tag, "type")) {
      errors.push(`${fileLabel} has a <source> without srcset and type: ${tag.slice(0, 120)}`);
    }
  }

  // Every link into the web app or Google Play names its placement for attribution.
  for (const tag of html.match(/<a\b[^>]*>/gu) || []) {
    const href = attribute(tag, "href") || "";

    if (
      /^https:\/\/(?:app\.linkdish\.ca|play\.google\.com)(?:[/?#]|$)/u.test(href) &&
      !attribute(tag, "data-cta")
    ) {
      errors.push(`${fileLabel} links to ${href} without a data-cta placement`);
    }
  }

  for (const rawReference of references) {
    if (/^(?:data|javascript|linkdish|mailto|sms):/iu.test(rawReference)) {
      continue;
    }

    let referenceUrl;

    try {
      referenceUrl = new URL(rawReference.replaceAll("&amp;", "&"), pageUrl);
    } catch {
      errors.push(`${fileLabel} has an invalid URL reference: ${rawReference}`);
      continue;
    }

    if (referenceUrl.origin !== siteOrigin) {
      continue;
    }

    const targetPath = localPathForUrl(referenceUrl);

    if (!targetPath || !(await exists(targetPath))) {
      errors.push(`${fileLabel} references missing site file: ${referenceUrl.pathname}`);
      continue;
    }

    if (referenceUrl.hash && targetPath.endsWith(".html")) {
      const targetHtml = htmlByPath.get(targetPath) || (await readFile(targetPath, "utf8"));
      const fragment = decodeURIComponent(referenceUrl.hash.slice(1));
      const escapedFragment = fragment.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

      if (fragment && !new RegExp(`\\bid=["']${escapedFragment}["']`, "u").test(targetHtml)) {
        errors.push(
          `${fileLabel} references missing fragment: ${referenceUrl.pathname}${referenceUrl.hash}`
        );
      }
    }
  }

  const pageText = visibleText(html);

  for (const match of html.matchAll(
    /<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gu
  )) {
    let data;

    try {
      data = JSON.parse(match[1]);
    } catch (error) {
      errors.push(`${fileLabel} has invalid JSON-LD: ${error.message}`);
      continue;
    }

    // FAQ rich results must mirror questions that are visible on the page.
    if (data["@type"] === "FAQPage") {
      for (const question of data.mainEntity || []) {
        if (!question?.name || !pageText.includes(question.name)) {
          errors.push(`${fileLabel} FAQPage question is not on the page: ${question?.name}`);
        }
      }
    }
  }

  const pageSocialImage = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/u)?.[1];
  const pageTwitterImage = html.match(/<meta\s+name="twitter:image"\s+content="([^"]+)"/u)?.[1];

  if (pageSocialImage && pageTwitterImage && pageSocialImage !== pageTwitterImage) {
    errors.push(`${fileLabel} og:image and twitter:image differ`);
  }

  if (pageSocialImage) {
    const socialUrl = new URL(pageSocialImage);
    const socialPath = socialUrl.origin === siteOrigin ? localPathForUrl(socialUrl) : null;

    if (!socialPath || !(await exists(socialPath))) {
      errors.push(`${fileLabel} og:image is not a local linkdish.ca asset: ${pageSocialImage}`);
    } else if ((await stat(socialPath)).size > maxSocialImageBytes) {
      errors.push(`${fileLabel} og:image is larger than 300 KB: ${pageSocialImage}`);
    }
  }

  if (
    fileLabel !== "404.html" &&
    !/<link\s+rel="canonical"\s+href="https:\/\/linkdish\.ca\//u.test(html)
  ) {
    errors.push(`${fileLabel} is missing a linkdish.ca canonical URL`);
  }
}

for (const filePath of files.filter((candidate) => candidate.endsWith(".css"))) {
  const css = await readFile(filePath, "utf8");
  const cssUrl = pageUrlForFile(filePath);

  for (const match of css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gu)) {
    const rawReference = match[1];

    if (rawReference.startsWith("data:")) {
      continue;
    }

    const referenceUrl = new URL(rawReference, cssUrl);

    if (referenceUrl.origin === siteOrigin) {
      const targetPath = localPathForUrl(referenceUrl);

      if (!targetPath || !(await exists(targetPath))) {
        errors.push(
          `${relativeSitePath(filePath)} references missing asset: ${referenceUrl.pathname}`
        );
      }
    }
  }
}

const homepage = await readFile(path.join(siteRoot, "index.html"), "utf8");
const openGraphImage = homepage.match(/<meta\s+property="og:image"\s+content="([^"]+)"/u)?.[1];
const twitterImage = homepage.match(/<meta\s+name="twitter:image"\s+content="([^"]+)"/u)?.[1];

if (!openGraphImage || openGraphImage !== twitterImage) {
  errors.push("Homepage Open Graph and Twitter image metadata must reference the same image");
} else {
  const socialImageUrl = new URL(openGraphImage);
  const socialImagePath = localPathForUrl(socialImageUrl);

  if (
    socialImageUrl.origin !== siteOrigin ||
    !socialImagePath ||
    !(await exists(socialImagePath))
  ) {
    errors.push(`Homepage social image is not a local linkdish.ca asset: ${openGraphImage}`);
  } else {
    const dimensions = await readPngDimensions(socialImagePath);

    if (!dimensions || dimensions.width !== 1200 || dimensions.height !== 630) {
      errors.push(`Homepage social image must be a 1200 x 630 PNG: ${openGraphImage}`);
    }
  }
}

const sitemap = await readFile(path.join(siteRoot, "sitemap.xml"), "utf8");
const sitemapUrls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/gu)].map((match) => match[1]);

for (const entry of sitemapUrls) {
  const entryUrl = new URL(entry);
  const entryPath = localPathForUrl(entryUrl);

  if (entryUrl.origin !== siteOrigin || !entryPath || !(await exists(entryPath))) {
    errors.push(`Sitemap entry does not resolve to a site page: ${entry}`);
  }
}

for (const requiredPage of [
  "/",
  "/meal-planner-and-grocery-list/",
  "/paprika-alternative/",
  "/privacy/",
  "/recipe-saver-app/",
  "/save-recipes-from-websites/",
  "/save-recipes-from-youtube/",
  "/scan-recipes-from-photos/",
  "/support/"
]) {
  if (!sitemapUrls.includes(`${siteOrigin}${requiredPage}`)) {
    errors.push(`Sitemap is missing ${requiredPage}`);
  }
}

const supportPage = await readFile(path.join(siteRoot, "support/index.html"), "utf8");
const supportApi = await readFile(path.join(repositoryRoot, "api/support-ticket.ts"), "utf8");
const supportOptions = [...supportPage.matchAll(/<option\s+value="([^"]+)"/gu)]
  .map((match) => match[1])
  .filter(Boolean)
  .sort();
const problemTypeEnum = supportApi.match(/problemType:\s*z[\s\S]*?\.enum\(\[([\s\S]*?)\]\)/u)?.[1];
const apiProblemTypes = problemTypeEnum
  ? [...problemTypeEnum.matchAll(/"([^"]+)"/gu)].map((match) => match[1]).sort()
  : [];

if (JSON.stringify(supportOptions) !== JSON.stringify(apiProblemTypes)) {
  errors.push("Support form problem types do not match the API enum");
}

if (!supportPage.includes('action="https://api.linkdish.ca/support-ticket"')) {
  errors.push("Support form action must target the production support-ticket endpoint");
}

for (const fieldName of [
  "details",
  "device",
  "email",
  "expected",
  "link",
  "problemType",
  "website"
]) {
  if (!supportPage.includes(`name="${fieldName}"`)) {
    errors.push(`Support form is missing the ${fieldName} field`);
  }
}

const analytics = await readFile(path.join(siteRoot, "analytics.js"), "utf8");

for (const requiredSnippet of [
  'window.location.hostname === "localhost"',
  "window.crypto.getRandomValues",
  'targetUrl.hostname === "app.linkdish.ca"',
  'targetUrl.hostname === "play.google.com"'
]) {
  if (!analytics.includes(requiredSnippet)) {
    errors.push(`Analytics hardening is missing: ${requiredSnippet}`);
  }
}

if (errors.length > 0) {
  console.error(
    `Site validation failed with ${errors.length} error${errors.length === 1 ? "" : "s"}:`
  );

  for (const error of errors) {
    console.error(`- ${error}`);
  }

  process.exitCode = 1;
} else {
  console.log(`Site validation passed (${htmlFiles.length} HTML pages, ${files.length} files).`);
}
