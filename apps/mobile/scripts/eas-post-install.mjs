import { spawnSync } from "node:child_process";

if (process.env.EAS_BUILD_PROFILE === "testflight") {
  const result = spawnSync(process.execPath, ["scripts/check-ios-release.mjs", "--offline"], {
    stdio: "inherit"
  });
  process.exit(result.status ?? 1);
}
