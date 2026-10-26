import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const plugin = require("./withSentrySourceMapUpload.js") as {
  __test: {
    addSentrySourceMapUpload: (contents: string) => string;
  };
};

const checkedInBuildGradle = readFileSync(
  fileURLToPath(new URL("../android/app/build.gradle", import.meta.url)),
  "utf8"
);

describe("withSentrySourceMapUpload", () => {
  it("applies sentry.gradle only when the build has a Sentry auth token", () => {
    const patched = plugin.__test.addSentrySourceMapUpload(
      'apply plugin: "com.facebook.react"\n\nandroid {\n    namespace "x"\n}\n'
    );

    expect(patched).toMatch(
      /if \(System\.getenv\("SENTRY_AUTH_TOKEN"\)\) \{\n\s+apply from: .*"sentry\.gradle"\)\n\}\n\nandroid \{/
    );
  });

  it("does not patch twice", () => {
    const once = plugin.__test.addSentrySourceMapUpload("android {\n}\n");

    expect(plugin.__test.addSentrySourceMapUpload(once)).toBe(once);
  });

  it("matches the checked-in Android project", () => {
    expect(checkedInBuildGradle).toContain('if (System.getenv("SENTRY_AUTH_TOKEN")) {');
    expect(plugin.__test.addSentrySourceMapUpload(checkedInBuildGradle)).toBe(checkedInBuildGradle);
  });
});
