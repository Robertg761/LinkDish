// @ts-check
/* eslint-disable @typescript-eslint/no-require-imports */

/** @type {typeof import("expo/config-plugins").withAppBuildGradle} */
const withAppBuildGradle = require("expo/config-plugins").withAppBuildGradle;

/*
 * Sentry's own Expo plugin applies sentry.gradle unconditionally, and that fails release builds
 * that have no SENTRY_AUTH_TOKEN. This applies it only when the token is present (an EAS secret,
 * with SENTRY_ORG and SENTRY_PROJECT), so builds without it are unchanged. The checked-in
 * android/app/build.gradle carries the same block.
 */
const SENTRY_SOURCE_MAP_UPLOAD = `// Sentry: upload release JS source maps when the build has SENTRY_AUTH_TOKEN, SENTRY_ORG and
// SENTRY_PROJECT. Without the token the build is unchanged.
if (System.getenv("SENTRY_AUTH_TOKEN")) {
    apply from: new File(["node", "--print", "require('path').dirname(require.resolve('@sentry/react-native/package.json'))"].execute().text.trim(), "sentry.gradle")
}
`;

const ANDROID_BLOCK = /^android \{/m;

/**
 * @param {string} contents
 * @returns {string}
 */
const addSentrySourceMapUpload = (contents) => {
  if (contents.includes("sentry.gradle") || !ANDROID_BLOCK.test(contents)) {
    return contents;
  }

  return contents.replace(ANDROID_BLOCK, `${SENTRY_SOURCE_MAP_UPLOAD}\nandroid {`);
};

/** @type {import("expo/config-plugins").ConfigPlugin} */
const withSentrySourceMapUpload = (config) =>
  withAppBuildGradle(config, (modConfig) => {
    if (modConfig.modResults.language === "groovy") {
      modConfig.modResults.contents = addSentrySourceMapUpload(modConfig.modResults.contents);
    }

    return modConfig;
  });

module.exports = withSentrySourceMapUpload;
module.exports.__test = {
  addSentrySourceMapUpload
};
