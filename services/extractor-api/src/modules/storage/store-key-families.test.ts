import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { findBackedUpKeyFamily, storeKeySegments } from "./store-key-families.js";

const repoRoot = fileURLToPath(new URL("../../../../../", import.meta.url));

const listSourceFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      return entry.name === "node_modules" ? [] : listSourceFiles(path);
    }

    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
  });

describe("store key classification", () => {
  it("covers every linkdish: key segment the API writes", () => {
    const unclassified: string[] = [];

    for (const file of [
      ...listSourceFiles(join(repoRoot, "services/extractor-api/src")),
      ...listSourceFiles(join(repoRoot, "api"))
    ]) {
      for (const match of readFileSync(file, "utf8").matchAll(/[`"']linkdish:([a-z-]+):/gu)) {
        const segment = match[1] as string;

        if (!(segment in storeKeySegments)) {
          unclassified.push(`${segment} (${relative(repoRoot, file)})`);
        }
      }
    }

    // A new key segment: add it to storeKeySegments, and to backedUpKeyFamilies if it is account
    // data, so the nightly backup (.github/workflows/backup-store.yml) copies it.
    expect(unclassified).toEqual([]);
  });

  it.each([
    ["linkdish:user:v1:u1", "user"],
    ["linkdish:household:v1:h1", "household"],
    ["linkdish:household-shopping-items:v1:h1", "household-shopping-items"],
    ["linkdish:household-recipe-by-source:v1:h1:u1:r1", "household-recipe-by-source"],
    ["linkdish:library:v1:item:u1:recipe:abc", "library-item"],
    ["linkdish:admin:v1:production:llm-settings", "admin-llm-settings"],
    ["linkdish:admin:billing-grant:v1:g1", "admin-billing-grant"],
    ["linkdish:ios-waitlist:v1:emails", "ios-waitlist-index"],
    ["linkdish:quota:v2:lifetime:import:user:u1", "quota-lifetime"]
  ])("backs up %s as %s", (key, family) => {
    expect(findBackedUpKeyFamily(key)?.name).toBe(family);
  });

  it.each([
    "linkdish:household-lock:v1:h1",
    "linkdish:library:v1:lock:u1",
    "linkdish:quota:v2:lifetime:import:user:u1:pending",
    "linkdish:quota:v2:2026-10:import:user:u1",
    "linkdish:auth-code:v1:hash",
    "linkdish:extract-cache:v9:abc",
    "linkdish:ios-waitlist-rate-limit:v1:hash"
  ])("leaves out %s", (key) => {
    expect(findBackedUpKeyFamily(key)).toBeUndefined();
  });
});
