import { buildAnalyticsPoolSslConfig } from "../src/modules/analytics/analytics-store.js";
import {
  canSendEmail,
  decideErrorAlert,
  ensureErrorAlertCheckpoint,
  formatErrorAlert,
  loadErrorAlertSnapshot,
  loadErrorAlertWindow,
  readErrorAlertChannels,
  readErrorAlertConfig,
  saveErrorAlertCheckpoint,
  sendErrorAlert
} from "../src/modules/analytics/error-alerts.js";

/*
 * Run by .github/workflows/error-alerts.yml. The repository's Actions logs are public, so this
 * prints counts only; error messages go to the email and webhook channels.
 */

const main = async (): Promise<number> => {
  const databaseUrl = process.env.ANALYTICS_DATABASE_URL?.trim();

  if (!databaseUrl) {
    console.log("ANALYTICS_DATABASE_URL is not set; skipping the error alert check.");
    return 0;
  }

  const config = readErrorAlertConfig(process.env);
  const channels = readErrorAlertChannels(process.env);
  const { Pool } = await import("pg");
  const ssl = buildAnalyticsPoolSslConfig();
  const pool = new Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 10_000,
    max: 2,
    ...(ssl ? { ssl } : {})
  });

  try {
    await ensureErrorAlertCheckpoint(pool);
    const alertWindow = await loadErrorAlertWindow(pool, config);
    const snapshot = await loadErrorAlertSnapshot(pool, config, alertWindow);
    const decision = decideErrorAlert(snapshot, config);

    console.log(
      `Last ${alertWindow.minutes} min: ${snapshot.total} errors, ${snapshot.fatal} fatal, ` +
        `${decision.newGroups.length} new.`
    );

    if (!decision.shouldAlert) {
      await saveErrorAlertCheckpoint(pool, alertWindow);
      return 0;
    }

    if (!canSendEmail(channels) && !channels.webhookUrl) {
      console.error(
        "An error alert fired, but no channel is configured. Set ERROR_ALERT_EMAIL_TO and " +
          "RESEND_API_KEY (and ERROR_ALERT_EMAIL_FROM or AUTH_EMAIL_FROM), or ERROR_ALERT_WEBHOOK_URL."
      );
      return 1;
    }

    const runUrl =
      process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
        ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
        : undefined;
    const result = await sendErrorAlert(formatErrorAlert(snapshot, decision, runUrl), channels);

    console.log(
      `Alert fired (${decision.reasons.length} reasons). Sent: ${result.sent.join(", ") || "none"}.` +
        (result.failed.length > 0 ? ` Failed: ${result.failed.join(", ")}.` : "")
    );

    // Undelivered alerts leave the checkpoint where it was, so the next run reports them again.
    if (result.sent.length === 0) {
      return 1;
    }

    await saveErrorAlertCheckpoint(pool, alertWindow);
    return 0;
  } finally {
    await pool.end();
  }
};

main().then(
  (exitCode) => {
    process.exitCode = exitCode;
  },
  (error: unknown) => {
    // A pg error can quote SQL or connection details, so only its class reaches the public log.
    console.error(
      `Error alert check failed: ${error instanceof Error ? error.name : "unknown error"}` +
        (error && typeof error === "object" && "code" in error ? ` (${String(error.code)})` : "")
    );
    process.exitCode = 1;
  }
);
