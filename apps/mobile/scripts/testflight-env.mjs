import { readFileSync } from "node:fs";

export const productionPublicEnv = JSON.parse(
  readFileSync(new URL("../config/production-public-env.json", import.meta.url), "utf8")
);
export const testflightProfile = JSON.parse(
  readFileSync(new URL("../eas.json", import.meta.url), "utf8")
).build.testflight;

export const resolveTestflightEnv = (publicEnv, profile, shellEnv = process.env) => {
  for (const [name, value] of Object.entries(publicEnv)) {
    if (
      !name.startsWith("EXPO_PUBLIC_") ||
      /SECRET|PRIVATE_KEY/.test(name) ||
      typeof value !== "string" ||
      !value.trim() ||
      /sk_(test|live)_|whsec_|-----BEGIN .*PRIVATE KEY-----/.test(value)
    ) {
      throw new Error(`Invalid public release configuration: ${name}.`);
    }
    if (profile.env?.[name] !== undefined && profile.env[name] !== value) {
      throw new Error(`Remove the conflicting TestFlight override for ${name}.`);
    }
    if (shellEnv.EAS_BUILD === "true" && shellEnv[name] !== value) {
      throw new Error(
        `EAS production differs for ${name}; run sync:ios:release-env before building.`
      );
    }
  }
  return {
    ...shellEnv,
    ...publicEnv,
    ...profile.env,
    NODE_ENV: "production",
    EXPO_NO_DOTENV: "1"
  };
};

export const getTestflightEnv = () => resolveTestflightEnv(productionPublicEnv, testflightProfile);
