import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const mobileRoot = resolve(scriptDir, "..");
const productionPublicEnvPath = join(mobileRoot, "config", "production-public-env.json");

const readProductionPublicEnv = () => {
  if (!existsSync(productionPublicEnvPath)) {
    return {};
  }

  return JSON.parse(readFileSync(productionPublicEnvPath, "utf8"));
};

const [command, ...args] = process.argv.slice(2);

if (!command) {
  console.error("Usage: node scripts/with-production-public-env.mjs <command> [...args]");
  process.exit(1);
}

const productionPublicEnv = readProductionPublicEnv();
const productionApiBaseUrl =
  process.env.LINKDISH_PRODUCTION_API_BASE_URL?.trim() ||
  productionPublicEnv.EXPO_PUBLIC_API_BASE_URL ||
  "https://api.linkdish.ca";

const env = {
  ...productionPublicEnv,
  ...process.env,
  NODE_ENV: "production",
  EXPO_NO_DOTENV: "1",
  EXPO_PUBLIC_USE_MOCK_API: "false",
  EXPO_PUBLIC_API_BASE_URL: productionApiBaseUrl,
  ORG_GRADLE_PROJECT_reactNativeArchitectures:
    process.env.ORG_GRADLE_PROJECT_reactNativeArchitectures ??
    "armeabi-v7a,arm64-v8a,x86,x86_64"
};

const child = spawn(command, args, {
  cwd: mobileRoot,
  env,
  stdio: "inherit"
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 1);
});
