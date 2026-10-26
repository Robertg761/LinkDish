/*
 * Hourly check over error_analytics (client_error events from web and Android). The scheduled
 * "Error Alerts" workflow runs it and sends the result to email (Resend) and/or a chat webhook.
 *
 * The repository and its Actions logs are public, so error messages only ever go to those private
 * channels; anything printed to stdout is counts.
 */

export interface ErrorAlertConfig {
  windowMinutes: number;
  minErrors: number;
  newErrorMinCount: number;
  baselineDays: number;
}

export interface ErrorAlertGroup {
  fingerprint: string;
  platform: string;
  count: number;
  fatalCount: number;
  visitors: number;
  message: string | null;
  routeOrScreen: string | null;
  appVersion: string | null;
  isNew: boolean;
}

export interface ErrorAlertSnapshot {
  total: number;
  fatal: number;
  groups: ErrorAlertGroup[];
}

export interface ErrorAlertDecision {
  shouldAlert: boolean;
  reasons: string[];
  newGroups: ErrorAlertGroup[];
}

export interface ErrorAlertMessage {
  subject: string;
  text: string;
}

export interface ErrorAlertChannels {
  resendApiKey?: string;
  emailFrom?: string;
  emailTo?: string[];
  webhookUrl?: string;
}

type Env = Record<string, string | undefined>;

// The slice of pg's Pool this module uses, so tests can pass a stub.
interface ErrorAlertQueryable {
  query: (text: string, values: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
}

const readPositiveInteger = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(value?.trim() ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const readOptional = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

export const readErrorAlertConfig = (env: Env): ErrorAlertConfig => ({
  windowMinutes: readPositiveInteger(env.ERROR_ALERT_WINDOW_MINUTES, 60),
  minErrors: readPositiveInteger(env.ERROR_ALERT_MIN_ERRORS, 25),
  newErrorMinCount: readPositiveInteger(env.ERROR_ALERT_NEW_ERROR_MIN_COUNT, 3),
  baselineDays: readPositiveInteger(env.ERROR_ALERT_BASELINE_DAYS, 7)
});

export const readErrorAlertChannels = (env: Env): ErrorAlertChannels => {
  const emailTo = (env.ERROR_ALERT_EMAIL_TO ?? "")
    .split(",")
    .map((address) => address.trim())
    .filter(Boolean);
  const resendApiKey = readOptional(env.RESEND_API_KEY);
  const emailFrom = readOptional(env.ERROR_ALERT_EMAIL_FROM) ?? readOptional(env.AUTH_EMAIL_FROM);
  const webhookUrl = readOptional(env.ERROR_ALERT_WEBHOOK_URL);

  return {
    ...(resendApiKey ? { resendApiKey } : {}),
    ...(emailFrom ? { emailFrom } : {}),
    ...(emailTo.length > 0 ? { emailTo } : {}),
    ...(webhookUrl ? { webhookUrl } : {})
  };
};

export const canSendEmail = (channels: ErrorAlertChannels): boolean =>
  Boolean(channels.resendApiKey && channels.emailFrom && channels.emailTo?.length);

const toNumber = (value: unknown): number =>
  typeof value === "number" ? value : typeof value === "string" ? Number(value) || 0 : 0;

const toNullableString = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

/*
 * Windows use received_at (server clock) rather than the client-reported occurred_at, so a
 * device with a wrong clock cannot hide its errors from the check.
 */
export const loadErrorAlertSnapshot = async (
  pool: ErrorAlertQueryable,
  config: ErrorAlertConfig
): Promise<ErrorAlertSnapshot> => {
  const [totalsResult, groupsResult] = await Promise.all([
    pool.query(
      `
        select
          count(*)::int as total,
          count(*) filter (where severity = 'fatal')::int as fatal
        from error_analytics
        where received_at >= now() - make_interval(mins => $1::int)
      `,
      [config.windowMinutes]
    ),
    pool.query(
      `
        select
          recent.error_fingerprint as fingerprint,
          recent.platform,
          count(*)::int as count,
          count(*) filter (where recent.severity = 'fatal')::int as fatal_count,
          count(distinct coalesce(recent.anonymous_id::text, recent.account_user_hash))::int
            as visitors,
          max(recent.message_class) as message,
          max(recent.route_or_screen) as route_or_screen,
          max(recent.app_version) as app_version,
          not exists (
            select 1
            from error_analytics earlier
            where earlier.error_fingerprint = recent.error_fingerprint
              and earlier.received_at < now() - make_interval(mins => $1::int)
              and earlier.received_at >= now() - make_interval(days => $2::int)
          ) as is_new
        from error_analytics recent
        where recent.received_at >= now() - make_interval(mins => $1::int)
        group by recent.error_fingerprint, recent.platform
        order by count desc, fingerprint
        limit 100
      `,
      [config.windowMinutes, config.baselineDays]
    )
  ]);
  const totals = totalsResult.rows[0] ?? {};

  return {
    total: toNumber(totals.total),
    fatal: toNumber(totals.fatal),
    groups: groupsResult.rows.map((row) => ({
      fingerprint: String(row.fingerprint),
      platform: toNullableString(row.platform) ?? "unknown",
      count: toNumber(row.count),
      fatalCount: toNumber(row.fatal_count),
      visitors: toNumber(row.visitors),
      message: toNullableString(row.message),
      routeOrScreen: toNullableString(row.route_or_screen),
      appVersion: toNullableString(row.app_version),
      isNew: row.is_new === true
    }))
  };
};

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`;

export const decideErrorAlert = (
  snapshot: ErrorAlertSnapshot,
  config: ErrorAlertConfig
): ErrorAlertDecision => {
  const reasons: string[] = [];
  const newGroups = snapshot.groups.filter(
    (group) => group.isNew && group.count >= config.newErrorMinCount
  );

  if (snapshot.fatal > 0) {
    reasons.push(`${plural(snapshot.fatal, "fatal error")} (app crashes)`);
  }

  if (snapshot.total >= config.minErrors) {
    reasons.push(
      `${plural(snapshot.total, "error")} in ${config.windowMinutes} minutes ` +
        `(alert threshold ${config.minErrors})`
    );
  }

  if (newGroups.length > 0) {
    reasons.push(
      `${plural(newGroups.length, "new error")} not seen in the previous ` +
        `${plural(config.baselineDays, "day")}`
    );
  }

  return {
    shouldAlert: reasons.length > 0,
    reasons,
    newGroups
  };
};

const describeGroup = (group: ErrorAlertGroup): string => {
  const details = [
    group.platform,
    group.routeOrScreen,
    group.appVersion ? `v${group.appVersion}` : null,
    group.visitors > 0 ? plural(group.visitors, "visitor") : null,
    group.fatalCount > 0 ? `${group.fatalCount} fatal` : null,
    group.isNew ? "new" : null
  ].filter(Boolean);

  return `- ${group.count}x ${group.message ?? group.fingerprint} (${details.join(", ")})`;
};

export const formatErrorAlert = (
  snapshot: ErrorAlertSnapshot,
  decision: ErrorAlertDecision,
  config: ErrorAlertConfig,
  runUrl?: string
): ErrorAlertMessage => {
  const topGroups = snapshot.groups.slice(0, 10);
  const newGroupsOutsideTop = decision.newGroups.filter((group) => !topGroups.includes(group));

  return {
    subject: `LinkDish error alert: ${decision.reasons[0] ?? "errors"}`,
    text: [
      `LinkDish error alert for the last ${config.windowMinutes} minutes.`,
      "",
      ...decision.reasons.map((reason) => `* ${reason}`),
      "",
      `Most frequent errors (${snapshot.total} total, ${snapshot.fatal} fatal):`,
      ...topGroups.map(describeGroup),
      ...(newGroupsOutsideTop.length > 0
        ? ["", "Other new errors:", ...newGroupsOutsideTop.map(describeGroup)]
        : []),
      "",
      "Details are in the admin dashboard and the error_analytics table.",
      ...(runUrl ? [`Workflow run: ${runUrl}`] : [])
    ].join("\n")
  };
};

type FetchLike = (url: string, init: RequestInit) => Promise<Pick<Response, "ok" | "status">>;

// Chat webhooks cap message length (Discord at 2,000 characters).
const WEBHOOK_TEXT_LIMIT = 1_900;

// Discord webhooks read `content`; Slack and most other chat webhooks read `text`.
export const buildWebhookPayload = (webhookUrl: string, text: string): Record<string, string> => {
  try {
    const hostname = new URL(webhookUrl).hostname;

    if (/(^|\.)discord(app)?\.com$/.test(hostname)) {
      return { content: text };
    }
  } catch {
    // Fall through to the Slack-style payload.
  }

  return { text };
};

export const sendErrorAlert = async (
  message: ErrorAlertMessage,
  channels: ErrorAlertChannels,
  fetchImpl: FetchLike = fetch
): Promise<{ sent: string[]; failed: string[] }> => {
  const sent: string[] = [];
  const failed: string[] = [];

  if (canSendEmail(channels)) {
    try {
      const response = await fetchImpl("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          authorization: `Bearer ${channels.resendApiKey ?? ""}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          from: channels.emailFrom,
          to: channels.emailTo,
          subject: message.subject,
          text: message.text
        })
      });

      if (response.ok) {
        sent.push("email");
      } else {
        failed.push(`email (HTTP ${response.status})`);
      }
    } catch {
      failed.push("email");
    }
  }

  if (channels.webhookUrl) {
    const text =
      message.text.length > WEBHOOK_TEXT_LIMIT
        ? `${message.text.slice(0, WEBHOOK_TEXT_LIMIT)}\n…`
        : message.text;

    try {
      const response = await fetchImpl(channels.webhookUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(buildWebhookPayload(channels.webhookUrl, text))
      });

      if (response.ok) {
        sent.push("webhook");
      } else {
        failed.push(`webhook (HTTP ${response.status})`);
      }
    } catch {
      failed.push("webhook");
    }
  }

  return { sent, failed };
};
