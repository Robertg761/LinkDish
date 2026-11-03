import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveTestflightEnv } from "./testflight-env.mjs";

const publicEnv = { EXPO_PUBLIC_API_BASE_URL: "https://api.linkdish.ca" };
const profile = { env: { EXPO_PUBLIC_USE_MOCK_API: "false" } };

test("local release commands override a development shell and disable dotenv", () => {
  const result = resolveTestflightEnv(publicEnv, profile, {
    EXPO_PUBLIC_API_BASE_URL: "http://localhost:3000",
    NODE_ENV: "development"
  });
  assert.equal(result.EXPO_PUBLIC_API_BASE_URL, "https://api.linkdish.ca");
  assert.equal(result.EXPO_PUBLIC_USE_MOCK_API, "false");
  assert.equal(result.NODE_ENV, "production");
  assert.equal(result.EXPO_NO_DOTENV, "1");
});

test("conflicting profile overrides cannot silently target staging", () => {
  assert.throws(
    () =>
      resolveTestflightEnv(
        publicEnv,
        {
          env: { EXPO_PUBLIC_API_BASE_URL: "https://staging-api.linkdish.ca" }
        },
        {}
      ),
    /conflicting TestFlight override/
  );
});

test("cloud builds fail when EAS variables are missing or stale", () => {
  for (const value of [undefined, "https://staging-api.linkdish.ca"]) {
    assert.throws(
      () =>
        resolveTestflightEnv(publicEnv, profile, {
          EAS_BUILD: "true",
          EXPO_PUBLIC_API_BASE_URL: value
        }),
      /EAS production differs/
    );
  }
  assert.equal(
    resolveTestflightEnv(publicEnv, profile, {
      EAS_BUILD: "true",
      ...publicEnv
    }).EXPO_PUBLIC_API_BASE_URL,
    publicEnv.EXPO_PUBLIC_API_BASE_URL
  );
});

test("server credentials and empty values cannot enter public configuration", () => {
  for (const invalid of [
    { CLERK_SECRET_KEY: "example" },
    { EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: "sk_live_example" },
    { EXPO_PUBLIC_REVENUECAT_IOS_API_KEY: "" }
  ]) {
    assert.throws(() => resolveTestflightEnv(invalid, profile, {}), /Invalid public release/);
  }
});
