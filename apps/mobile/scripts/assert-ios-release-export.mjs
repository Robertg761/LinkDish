import { readFileSync } from "node:fs";

import { getTestflightEnv } from "./testflight-env.mjs";

const env = getTestflightEnv();
const root = new URL("../dist-ios-testflight/", import.meta.url);
const metadata = JSON.parse(readFileSync(new URL("metadata.json", root), "utf8"));
const bundle = readFileSync(new URL(metadata.fileMetadata.ios.bundle, root));
for (const name of [
  "EXPO_PUBLIC_API_BASE_URL",
  "EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY",
  "EXPO_PUBLIC_REVENUECAT_IOS_API_KEY"
]) {
  if (!env[name] || !bundle.includes(Buffer.from(env[name]))) {
    throw new Error(`The iOS bundle is missing the production value for ${name}.`);
  }
}
for (const marker of [
  "https://staging-api.linkdish.ca",
  "@linkdish.test",
  "Use simulated household",
  "Reset preview to Free"
]) {
  if (bundle.includes(Buffer.from(marker))) {
    throw new Error("The iOS bundle still contains staging or debug-only configuration.");
  }
}
if (
  /sk_(?:test|live)_[A-Za-z0-9]{16,}|whsec_[A-Za-z0-9]{16,}|-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/.test(
    bundle.toString("latin1")
  )
) {
  throw new Error("A possible server credential was detected in the iOS bundle.");
}
console.log(
  "iOS export verified: production API, Clerk, and RevenueCat; no checked staging/debug/secret markers."
);
