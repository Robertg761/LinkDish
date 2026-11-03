import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { getTestflightEnv } from "./testflight-env.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error("Pass the command to run with the TestFlight environment.");
const child = spawn(command, args, {
  cwd: root,
  stdio: "inherit",
  env: getTestflightEnv()
});
child.on("error", () => {
  console.error("Unable to start the TestFlight command.");
  process.exit(1);
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
