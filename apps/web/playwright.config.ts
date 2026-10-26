import { defineConfig, devices } from "@playwright/test";

import { E2E_API_ORIGIN } from "./e2e/api-origin";

const isCI = Boolean(process.env.CI);
/** Not Vite's preview default (4173), so a preview pointed at the real API is never reused. */
const PORT = 4183;
const baseURL = `http://localhost:${PORT}`;

/**
 * End-to-end tests run the production build (vite build + vite preview) in Chromium, with every
 * API call answered by the mock in e2e/fixtures.ts. See e2e/README.md.
 */
export default defineConfig({
  testDir: "./e2e",
  // Not *.test.ts / *.spec.ts: those belong to Vitest, which would try to run these.
  testMatch: "**/*.e2e.ts",
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  reporter: isCI ? [["github"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL,
    locale: "en-US",
    timezoneId: "UTC",
    // A service worker would answer fetches itself, out of reach of the API mock.
    serviceWorkers: "block",
    trace: "retain-on-failure",
    screenshot: "only-on-failure"
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } }
  ],
  webServer: {
    command: `pnpm exec vite build --outDir dist-e2e --logLevel error && pnpm exec vite preview --outDir dist-e2e --port ${PORT} --strictPort`,
    url: baseURL,
    // Set here so a local .env can't point the build at the real API, Clerk or RevenueCat.
    env: {
      VITE_LINKDISH_API_BASE_URL: E2E_API_ORIGIN,
      VITE_CLERK_PUBLISHABLE_KEY: "",
      VITE_REVENUECAT_WEB_PUBLIC_API_KEY: ""
    },
    reuseExistingServer: !isCI,
    timeout: 180_000,
    stdout: "ignore",
    stderr: "pipe"
  }
});
