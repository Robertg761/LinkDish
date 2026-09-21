import { afterEach, describe, expect, it, vi } from "vitest";

const importAnalyticsStore = async (env: Record<string, string>) => {
  vi.resetModules();

  for (const [key, value] of Object.entries({
    ANALYTICS_ENABLED: "true",
    ANALYTICS_DATABASE_ALLOW_INSECURE_TLS: "false",
    ANALYTICS_DATABASE_CA_CERT: "",
    ...env
  })) {
    vi.stubEnv(key, value);
  }

  return import("./analytics-store.js");
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("buildAnalyticsPoolSslConfig", () => {
  it("verifies the server certificate for remote analytics databases", async () => {
    const { buildAnalyticsPoolSslConfig } = await importAnalyticsStore({
      ANALYTICS_DATABASE_URL: "postgres://user:pass@db.example.com:5432/analytics"
    });

    expect(buildAnalyticsPoolSslConfig()).toMatchObject({
      rejectUnauthorized: true
    });
  });

  it("pins an explicit CA bundle when one is configured", async () => {
    const { buildAnalyticsPoolSslConfig } = await importAnalyticsStore({
      ANALYTICS_DATABASE_URL: "postgres://user:pass@db.example.com:5432/analytics",
      ANALYTICS_DATABASE_CA_CERT: "-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----"
    });

    expect(buildAnalyticsPoolSslConfig()).toEqual({
      ca: "-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----",
      rejectUnauthorized: true
    });
  });

  it("keeps the local development path plaintext", async () => {
    const { buildAnalyticsPoolSslConfig } = await importAnalyticsStore({
      ANALYTICS_DATABASE_URL: "postgres://postgres@localhost:5432/analytics"
    });

    expect(buildAnalyticsPoolSslConfig()).toBeUndefined();

    const loopback = await importAnalyticsStore({
      ANALYTICS_DATABASE_URL: "postgres://postgres@127.0.0.1:5432/analytics"
    });

    expect(loopback.buildAnalyticsPoolSslConfig()).toBeUndefined();
  });

  it("does not treat a remote host that merely contains 'localhost' as local", async () => {
    const { buildAnalyticsPoolSslConfig } = await importAnalyticsStore({
      ANALYTICS_DATABASE_URL: "postgres://user:pass@not-localhost.example.com:5432/analytics"
    });

    expect(buildAnalyticsPoolSslConfig()).toMatchObject({
      rejectUnauthorized: true
    });
  });

  it("only disables verification behind the explicit opt-in", async () => {
    const { buildAnalyticsPoolSslConfig } = await importAnalyticsStore({
      ANALYTICS_DATABASE_URL: "postgres://user:pass@db.example.com:5432/analytics",
      ANALYTICS_DATABASE_ALLOW_INSECURE_TLS: "true"
    });

    expect(buildAnalyticsPoolSslConfig()).toEqual({
      rejectUnauthorized: false
    });
  });
});
