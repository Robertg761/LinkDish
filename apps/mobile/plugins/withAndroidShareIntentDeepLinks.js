// @ts-check
/* eslint-disable @typescript-eslint/no-require-imports */

/** @type {typeof import("node:fs")} */
const fs = require("node:fs");
/** @type {typeof import("node:path")} */
const path = require("node:path");

/** @type {typeof import("expo/config-plugins").withDangerousMod} */
const withDangerousMod = require("expo/config-plugins").withDangerousMod;

const DEFAULT_SCHEME = "linkdish";

const REQUIRED_IMPORTS = [
  "import android.content.ClipData",
  "import android.content.Intent",
  "import android.net.Uri",
  "import android.os.Build",
  "import java.net.URLEncoder"
];

/**
 * @param {string} scheme
 * @returns {string}
 */
const buildShareIntentMethods = (scheme) => `  override fun onNewIntent(intent: Intent) {
    val rewrittenIntent = rewriteSendIntent(intent)
    setIntent(rewrittenIntent)
    super.onNewIntent(rewrittenIntent)
  }

  private fun rewriteSendIntent(sourceIntent: Intent): Intent {
    if (sourceIntent.action != Intent.ACTION_SEND) {
      return sourceIntent
    }

    val mimeType = sourceIntent.type

    if (mimeType?.startsWith("image/") == true) {
      val sharedImageUri = getSharedImageUri(sourceIntent)

      if (sharedImageUri != null) {
        val encodedImageUri = URLEncoder.encode(sharedImageUri.toString(), "UTF-8")
        val encodedMimeType = URLEncoder.encode(mimeType, "UTF-8")
        val importUri = Uri.parse("${scheme}://import-progress?imageUri=$encodedImageUri&mimeType=$encodedMimeType")
        sourceIntent.setAction(Intent.ACTION_VIEW)
        sourceIntent.setData(importUri)
        sourceIntent.setPackage(packageName)
        sourceIntent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)

        if (sourceIntent.clipData == null) {
          sourceIntent.clipData = ClipData.newRawUri("Shared recipe image", sharedImageUri)
        }

        return sourceIntent
      }
    }

    val sharedText = sourceIntent.getStringExtra(Intent.EXTRA_TEXT)?.trim()

    if (!sharedText.isNullOrEmpty()) {
      val encodedText = URLEncoder.encode(sharedText, "UTF-8")
      val importUri = Uri.parse("${scheme}://import-progress?text=$encodedText")
      sourceIntent.setAction(Intent.ACTION_VIEW)
      sourceIntent.setData(importUri)
      sourceIntent.setPackage(packageName)
      return sourceIntent
    }

    return sourceIntent
  }

  @Suppress("DEPRECATION")
  private fun getSharedImageUri(sourceIntent: Intent): Uri? =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      sourceIntent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
    } else {
      sourceIntent.getParcelableExtra(Intent.EXTRA_STREAM) as? Uri
    }

`;

/**
 * @param {string} androidRoot
 * @param {string | undefined} packageName
 * @returns {string}
 */
const findMainActivityPath = (androidRoot, packageName) => {
  const packagePath = packageName ? packageName.replaceAll(".", path.sep) : "";
  const directCandidates = packagePath
    ? [
        path.join(androidRoot, "app/src/main/java", packagePath, "MainActivity.kt"),
        path.join(androidRoot, "app/src/main/kotlin", packagePath, "MainActivity.kt")
      ]
    : [];

  const directMatch = directCandidates.find((candidate) => fs.existsSync(candidate));

  if (directMatch) {
    return directMatch;
  }

  const roots = [
    path.join(androidRoot, "app/src/main/java"),
    path.join(androidRoot, "app/src/main/kotlin")
  ];

  /** @type {string[]} */
  const queue = roots.filter((root) => fs.existsSync(root));

  while (queue.length > 0) {
    const current = queue.shift();

    if (!current) {
      continue;
    }

    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);

      if (entry.isDirectory()) {
        queue.push(entryPath);
        continue;
      }

      if (entry.name === "MainActivity.kt") {
        return entryPath;
      }
    }
  }

  throw new Error("Unable to find generated Android MainActivity.kt");
};

/**
 * @param {string} contents
 * @returns {string}
 */
const ensureImports = (contents) => {
  const missingImports = REQUIRED_IMPORTS.filter((importLine) => !contents.includes(importLine));

  if (missingImports.length === 0) {
    return contents;
  }

  if (/^import /mu.test(contents)) {
    return contents.replace(/^import /mu, `${missingImports.join("\n")}\n$&`);
  }

  return contents.replace(/^(package [^\n]+\n)/mu, `$1\n${missingImports.join("\n")}\n`);
};

/**
 * @param {string} contents
 * @returns {string}
 */
const ensureOnCreateRewritesSendIntent = (contents) => {
  const onCreatePattern =
    /override fun onCreate\(savedInstanceState: Bundle\?\) \{\n([\s\S]*?)\n {2}\}/u;
  const match = contents.match(onCreatePattern);

  if (!match) {
    throw new Error("Unable to patch MainActivity.kt: onCreate override was not found");
  }

  return contents.replace(onCreatePattern, (_onCreateBlock, body) => {
    const onCreateBody =
      typeof body === "string"
        ? body.replace(/^ {4}setIntent\(rewriteSendIntent\(intent\)\)\n?/mu, "")
        : "";

    return `override fun onCreate(savedInstanceState: Bundle?) {\n    setIntent(rewriteSendIntent(intent))\n${onCreateBody}\n  }`;
  });
};

/**
 * @param {string} contents
 * @param {string} scheme
 * @returns {string}
 */
const ensureShareIntentMethods = (contents, scheme) => {
  if (contents.includes("private fun rewriteSendIntent(sourceIntent: Intent): Intent")) {
    const methodsStart = contents.indexOf("  override fun onNewIntent(intent: Intent)");
    const methodsEnd = contents.indexOf("  /**", methodsStart);

    if (methodsStart < 0 || methodsEnd < 0) {
      throw new Error(
        "Unable to patch MainActivity.kt: existing share intent methods were not recognized"
      );
    }

    return `${contents.slice(0, methodsStart)}${buildShareIntentMethods(scheme)}${contents.slice(methodsEnd)}`;
  }

  const onCreatePattern =
    /override fun onCreate\(savedInstanceState: Bundle\?\) \{\n[\s\S]*?\n {2}\}\n\n/u;
  const match = contents.match(onCreatePattern);

  if (!match) {
    throw new Error("Unable to patch MainActivity.kt: onCreate override was not found");
  }

  return contents.replace(match[0], `${match[0]}${buildShareIntentMethods(scheme)}`);
};

/**
 * @param {string} contents
 * @param {string} scheme
 * @returns {string}
 */
const patchMainActivity = (contents, scheme) =>
  ensureShareIntentMethods(ensureOnCreateRewritesSendIntent(ensureImports(contents)), scheme);

/** @type {import("expo/config-plugins").ConfigPlugin<{ scheme?: string } | undefined>} */
const withAndroidShareIntentDeepLinks = (config, options = {}) =>
  withDangerousMod(config, [
    "android",
    (modConfig) => {
      const configScheme = typeof config.scheme === "string" ? config.scheme : undefined;
      const scheme = options?.scheme ?? configScheme ?? DEFAULT_SCHEME;
      const mainActivityPath = findMainActivityPath(
        modConfig.modRequest.platformProjectRoot,
        config.android?.package
      );
      const contents = fs.readFileSync(mainActivityPath, "utf8");
      const patchedContents = patchMainActivity(contents, scheme);

      if (patchedContents !== contents) {
        fs.writeFileSync(mainActivityPath, patchedContents);
      }

      return modConfig;
    }
  ]);

module.exports = withAndroidShareIntentDeepLinks;
module.exports.__test = {
  buildShareIntentMethods,
  patchMainActivity
};
