import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { getTestflightEnv, productionPublicEnv } from "./testflight-env.mjs";

// Validate before writing to EAS. Only public mobile configuration is synchronized.
getTestflightEnv();
const cwd = fileURLToPath(new URL("../", import.meta.url));
for (const [name, value] of Object.entries(productionPublicEnv)) {
  const result = spawnSync(
    "npx",
    [
      "--yes",
      "eas-cli@latest",
      "env:set",
      "production",
      "--scope",
      "project",
      "--name",
      name,
      "--value",
      value,
      "--type",
      "string",
      "--visibility",
      "plaintext",
      "--non-interactive"
    ],
    { cwd, encoding: "utf8" }
  );
  if (result.status !== 0) {
    console.error(`Could not synchronize ${name}; check EAS login and project permissions.`);
    process.exit(1);
  }
  console.log(`Synchronized ${name} to EAS production.`);
}
