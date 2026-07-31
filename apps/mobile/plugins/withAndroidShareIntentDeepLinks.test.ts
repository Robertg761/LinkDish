import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const plugin = require("./withAndroidShareIntentDeepLinks.js") as {
  __test: {
    buildShareIntentMethods: (scheme: string) => string;
  };
};

describe("withAndroidShareIntentDeepLinks", () => {
  it("routes Android image shares through the image import screen with URI permission", () => {
    const methods = plugin.__test.buildShareIntentMethods("linkdish");

    expect(methods).toContain('mimeType?.startsWith("image/") == true');
    expect(methods).toContain("Intent.EXTRA_STREAM");
    expect(methods).toContain("import-progress?imageUri=");
    expect(methods).toContain("Intent.FLAG_GRANT_READ_URI_PERMISSION");
    expect(methods).not.toContain("TODO: Route image shares");
  });
});
