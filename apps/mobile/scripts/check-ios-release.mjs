import { readFileSync } from "node:fs";

import { getTestflightEnv, testflightProfile as profile } from "./testflight-env.mjs";

const env = getTestflightEnv();
const failures = [];
const requireCheck = (condition, message) => {
  if (!condition) failures.push(message);
};
requireCheck(
  profile.distribution === "store" && !profile.developmentClient,
  "TestFlight requires a store build without a development client."
);
requireCheck(
  profile.ios?.buildConfiguration === "Release",
  "TestFlight must use the Release configuration."
);
requireCheck(
  profile.environment === "production" &&
    env.EXPO_PUBLIC_API_BASE_URL === "https://api.linkdish.ca",
  "TestFlight must use the production EAS environment and API."
);
for (const name of [
  "EXPO_PUBLIC_USE_MOCK_API",
  "EXPO_PUBLIC_ENABLE_LOCAL_PLAN_PREVIEW",
  "EXPO_PUBLIC_ENABLE_DEBUG_HOUSEHOLD_SIMULATOR"
]) {
  requireCheck(env[name] === "false", `${name} must be false.`);
}
const key = env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY ?? "";
requireCheck(
  /^pk_live_[A-Za-z0-9=]+$/.test(key),
  "A production Clerk publishable key is required."
);
for (const [name, value] of Object.entries(profile.env)) {
  requireCheck(
    !/SECRET|PRIVATE_KEY/.test(name) && !/^(sk_(test|live)_|whsec_)/.test(value),
    "Server credentials must never be in the TestFlight profile."
  );
}
const iosClient = env.EXPO_PUBLIC_CLERK_GOOGLE_IOS_CLIENT_ID ?? "";
requireCheck(
  iosClient.endsWith(".apps.googleusercontent.com"),
  "A Google iOS OAuth client is required."
);
requireCheck(
  env.EXPO_PUBLIC_CLERK_GOOGLE_IOS_URL_SCHEME ===
    `com.googleusercontent.apps.${iosClient.replace(/\.apps\.googleusercontent\.com$/, "")}`,
  "The Google callback scheme must match the iOS OAuth client."
);
requireCheck(
  env.EXPO_PUBLIC_CLERK_GOOGLE_WEB_CLIENT_ID?.endsWith(".apps.googleusercontent.com"),
  "A Google web OAuth client is required."
);
requireCheck(
  readFileSync(new URL("../ios/LinkDish/Info.plist", import.meta.url), "utf8").includes(
    `<string>${env.EXPO_PUBLIC_CLERK_GOOGLE_IOS_URL_SCHEME}</string>`
  ),
  "The native iOS Google callback scheme must match the production configuration."
);
requireCheck(
  env.EXPO_PUBLIC_REVENUECAT_IOS_API_KEY?.startsWith("appl_"),
  "The iOS RevenueCat public SDK key is missing; purchases and restore need device validation."
);
requireCheck(
  env.EXPO_PUBLIC_CLERK_APPLE_SIGN_IN_ENABLED === "true",
  "The iOS release must enable the Apple sign-in button."
);

if (!process.argv.includes("--offline")) {
  try {
    const response = await fetch(`${env.EXPO_PUBLIC_API_BASE_URL}/auth/config`, {
      signal: AbortSignal.timeout(10000)
    });
    const config = await response.json();
    requireCheck(
      response.ok && config.clerkEnabled === true,
      "The production API must enable Clerk with the matching production instance."
    );
    const session = await fetch(`${env.EXPO_PUBLIC_API_BASE_URL}/auth/session`, {
      signal: AbortSignal.timeout(10000)
    });
    requireCheck(
      session.ok,
      "Production auth/session is unavailable; verify HOUSEHOLDS_ENABLED on the backend."
    );
    const host = Buffer.from(key.replace(/^pk_(test|live)_/, ""), "base64")
      .toString()
      .replace(/\$$/, "");
    requireCheck(/^[a-zA-Z0-9.-]+$/.test(host), "Invalid Clerk frontend hostname.");
    if (/^[a-zA-Z0-9.-]+$/.test(host)) {
      const clerkResponse = await fetch(`https://${host}/v1/environment`, {
        signal: AbortSignal.timeout(10000)
      });
      const json = await clerkResponse.json();
      const clerk = json.response ?? json;
      requireCheck(
        clerkResponse.ok &&
          clerk.display_config?.google_one_tap_client_id ===
            env.EXPO_PUBLIC_CLERK_GOOGLE_WEB_CLIENT_ID,
        "Clerk Google custom credentials do not match this build."
      );
      requireCheck(
        clerk.user_settings?.social?.oauth_apple?.enabled === true,
        "Enable and verify Sign in with Apple in this Clerk instance before App Store release."
      );
    }
  } catch {
    failures.push(
      "Unable to verify production API/Clerk availability; release readiness is unverified."
    );
  }
}
if (failures.length) {
  console.error(failures.map((message) => `BLOCKER: ${message}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log(
    process.argv.includes("--offline")
      ? "Offline TestFlight configuration passed; live auth and billing remain unverified."
      : "Release preflight passed; complete real-device sign-in and purchase validation before submission."
  );
}
