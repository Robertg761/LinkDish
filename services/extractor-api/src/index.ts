import { buildApp } from "./app.js";
import { extractorApiEnv } from "./config/env.js";

const start = async () => {
  const app = buildApp();

  try {
    await app.listen({
      host: "0.0.0.0",
      port: extractorApiEnv.PORT
    });
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
};

void start();
