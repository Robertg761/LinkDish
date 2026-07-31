import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const mobileRoot = resolve(scriptDir, "..");
const distDir = join(mobileRoot, "dist");
const productionPublicEnvPath = join(mobileRoot, "config", "production-public-env.json");
const envOnly = process.argv.includes("--env-only");

const isTrue = (value) => typeof value === "string" && value.trim().toLowerCase() === "true";
const isBlank = (value) => typeof value !== "string" || value.trim().length === 0;
const isLocalUrl = (value) =>
  typeof value === "string" &&
  /^(https?:\/\/)?(localhost|127\.0\.0\.1|0\.0\.0\.0)([:/]|$)/u.test(value);

const failures = [];

const addFailure = (message) => {
  failures.push(message);
};

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

const readProductionPublicEnv = () => {
  if (!existsSync(productionPublicEnvPath)) {
    return {};
  }

  return readJson(productionPublicEnvPath);
};

const assertProductionEnv = () => {
  const easPath = join(mobileRoot, "eas.json");
  const easConfig = readJson(easPath);
  const productionProfile = easConfig.build?.production;
  const productionEnv = productionProfile?.env ?? {};
  const productionPublicEnv = readProductionPublicEnv();

  if (productionProfile?.environment !== "production") {
    addFailure("EAS production profile must set environment to production.");
  }

  if (isTrue(productionEnv.EXPO_PUBLIC_ENABLE_DEBUG_HOUSEHOLD_SIMULATOR)) {
    addFailure("EAS production env enables the household simulator.");
  }

  if (isTrue(process.env.EXPO_PUBLIC_ENABLE_DEBUG_HOUSEHOLD_SIMULATOR)) {
    addFailure("Current shell enables EXPO_PUBLIC_ENABLE_DEBUG_HOUSEHOLD_SIMULATOR.");
  }

  if (isTrue(productionEnv.EXPO_PUBLIC_ENABLE_LOCAL_PLAN_PREVIEW)) {
    addFailure("EAS production env enables local plan previews.");
  }

  if (isTrue(process.env.EXPO_PUBLIC_ENABLE_LOCAL_PLAN_PREVIEW)) {
    addFailure("Current shell enables EXPO_PUBLIC_ENABLE_LOCAL_PLAN_PREVIEW.");
  }

  if (
    isTrue(productionEnv.EXPO_PUBLIC_USE_MOCK_API) ||
    isTrue(process.env.EXPO_PUBLIC_USE_MOCK_API)
  ) {
    addFailure("Production release env must not enable the mock API.");
  }

  const configuredApiBaseUrl =
    process.env.EXPO_PUBLIC_API_BASE_URL ?? productionEnv.EXPO_PUBLIC_API_BASE_URL;
  if (isLocalUrl(configuredApiBaseUrl)) {
    addFailure(`Production release env points at a local API URL: ${configuredApiBaseUrl}`);
  }

  const configuredClerkPublishableKey =
    process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY ??
    productionPublicEnv.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY ??
    productionEnv.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY;

  if (isBlank(configuredClerkPublishableKey)) {
    addFailure("Production release env must set EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY.");
  }

  if (typeof configuredClerkPublishableKey === "string") {
    const trimmedKey = configuredClerkPublishableKey.trim();

    if (trimmedKey.startsWith("pk_test_")) {
      addFailure("Production release env must not use a Clerk pk_test_ publishable key.");
    }
  }
};

const walkFiles = (directory) => {
  const entries = readdirSync(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...walkFiles(path));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }

  return files;
};

const forbiddenProductionBundleNeedles = [
  "/debug/household/full",
  "@linkdish.test",
  "debug.linkdish.test",
  "Use simulated household",
  "Debug household simulator",
  "debug household simulator",
  "createDebugFullHouseholdSimulation",
  "Activate LinkDish Plus preview",
  "Activate LinkDish Family preview",
  "Reset preview to Free"
];

const assertDistHasNoDebugOnlyControls = () => {
  if (!existsSync(distDir) || !statSync(distDir).isDirectory()) {
    addFailure(
      "Missing apps/mobile/dist. Run pnpm --filter @linkdish/mobile export:release first."
    );
    return;
  }

  for (const file of walkFiles(distDir)) {
    const content = readFileSync(file);
    const relativePath = relative(mobileRoot, file);

    for (const needle of forbiddenProductionBundleNeedles) {
      if (content.includes(Buffer.from(needle))) {
        addFailure(`Production export contains "${needle}" in ${relativePath}.`);
      }
    }
  }
};

const assertDistHasProductionClerkKey = () => {
  if (!existsSync(distDir) || !statSync(distDir).isDirectory()) {
    return;
  }

  let foundLiveKey = false;

  for (const file of walkFiles(distDir)) {
    const content = readFileSync(file);
    const relativePath = relative(mobileRoot, file);

    // Clerk publishable keys are a long unbroken base64 run after the prefix.
    // A bare "pk_test_" substring check false-positives on the RevenueCat
    // SDK's internal "pk_test_store_operation_session_id" pattern literal.
    if (/pk_test_[A-Za-z0-9]{20,}/u.test(content.toString("latin1"))) {
      addFailure(`Production export contains a Clerk pk_test_ key in ${relativePath}.`);
    }

    if (content.includes(Buffer.from("pk_live_"))) {
      foundLiveKey = true;
    }
  }

  if (!foundLiveKey) {
    addFailure("Production export does not contain a Clerk pk_live_ publishable key.");
  }
};

assertProductionEnv();

if (!envOnly) {
  assertDistHasNoDebugOnlyControls();
  assertDistHasProductionClerkKey();
}

if (failures.length > 0) {
  console.error("Production cleanliness check failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log(
  envOnly
    ? "Production env check passed."
    : "Production cleanliness check passed: no debug-only mobile controls found."
);
