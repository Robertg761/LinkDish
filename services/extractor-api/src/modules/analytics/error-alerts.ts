/*
 * Hourly check over error_analytics (client_error events from web and Android). The scheduled
 * "Error Alerts" workflow runs it and sends the result to email (Resend) and/or a chat webhook.
 *
 * Each run checks the errors received since the last run that finished (a checkpoint row in
 * error_alert_checkpoints), so a late or skipped GitHub cron run neither drops errors nor reports
 * them twice. A run that fires an alert but cannot deliver it leaves the checkpoint alone, and the
 * next run covers both windows. Catch-up is capped at a day.
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

export interface ErrorAlertWindow {
  since: Date;
  until: Date;
  minutes: number;
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
  // First seen within the last day and not in the rest of the baseline.
  isNew: boolean;
  countLastDay: number;
  countLastDayBeforeWindow: number;
}

export interface ErrorAlertSnapshot {
  window: ErrorAlertWindow;
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

const toDate = (value: unknown): Date | null => {
  if (value instanceof Date) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  return null;
};

const MINUTE_MS = 60_000;
const MAX_CATCH_UP_MS = 24 * 60 * MINUTE_MS;

export const ensureErrorAlertCheckpoint = async (pool: ErrorAlertQueryable): Promise<void> => {
  await pool.query(
    `
      create table if not exists error_alert_checkpoints (
        id smallint primary key,
        checked_until timestamptz not null
      )
    `,
    []
  );
};

/*
 * Windows use received_at and the database clock rather than the client-reported occurred_at,
 * so a device with a wrong clock cannot hide its errors from the check.
 */
export const loadErrorAlertWindow = async (
  pool: ErrorAlertQueryable,
  config: ErrorAlertConfig
): Promise<ErrorAlertWindow> => {
  const result = await pool.query(
    `
      select
        now() as until,
        (select checked_until from error_alert_checkpoints where id = 1) as checked_until
    `,
    []
  );
  const row = result.rows[0] ?? {};
  const until = toDate(row.until) ?? new Date();
  const checkedUntil = toDate(row.checked_until);
  const sinceMs = checkedUntil
    ? Math.min(Math.max(checkedUntil.getTime(), until.getTime() - MAX_CATCH_UP_MS), until.getTime())
    : until.getTime() - config.windowMinutes * MINUTE_MS;

  return {
    since: new Date(sinceMs),
    until,
    minutes: Math.max(1, Math.round((until.getTime() - sinceMs) / MINUTE_MS))
  };
};

export const saveErrorAlertCheckpoint = async (
  pool: ErrorAlertQueryable,
  window: ErrorAlertWindow
): Promise<void> => {
  await pool.query(
    `
      insert into error_alert_checkpoints (id, checked_until)
      values (1, $1)
      on conflict (id) do update set checked_until = excluded.checked_until
    `,
    [window.until.toISOString()]
  );
};

export const loadErrorAlertSnapshot = async (
  pool: ErrorAlertQueryable,
  config: ErrorAlertConfig,
  window: ErrorAlertWindow
): Promise<ErrorAlertSnapshot> => {
  const since = window.since.toISOString();
  const until = window.until.toISOString();
  const [totalsResult, groupsResult] = await Promise.all([
    pool.query(
      `
        select
          count(*)::int as total,
          count(*) filter (where severity = 'fatal')::int as fatal
        from error_analytics
        where received_at > $1::timestamptz and received_at <= $2::timestamptz
      `,
      [since, until]
    ),
    /*
     * Each fingerprint seen in the window, with its history over the baseline. A new error is
     * reported by the run in which its count over the last day reaches the threshold, even when
     * its first occurrences fell in an earlier run's window.
     */
    pool.query(
      `
        with in_window as (
          select distinct error_fingerprint
          from error_analytics
          where received_at > $1::timestamptz and received_at <= $2::timestamptz
        )
        select
          e.error_fingerprint as fingerprint,
          max(e.platform) as platform,
          count(*) filter (where e.received_at > $1::timestamptz)::int as count,
          count(*) filter (
            where e.received_at > $1::timestamptz and e.severity = 'fatal'
          )::int as fatal_count,
          count(distinct coalesce(e.anonymous_id::text, e.account_user_hash)) filter (
            where e.received_at > $1::timestamptz
          )::int as visitors,
          max(e.message_class) filter (where e.received_at > $1::timestamptz) as message,
          max(e.route_or_screen) filter (where e.received_at > $1::timestamptz)
            as route_or_screen,
          max(e.app_version) filter (where e.received_at > $1::timestamptz) as app_version,
          min(e.received_at) > $2::timestamptz - interval '1 day' as is_new,
          count(*) filter (
            where e.received_at > $2::timestamptz - interval '1 day'
          )::int as count_last_day,
          count(*) filter (
            where e.received_at > $2::timestamptz - interval '1 day'
              and e.received_at <= $1::timestamptz
          )::int as count_last_day_before_window
        from error_analytics e
        join in_window using (error_fingerprint)
        where e.received_at > $2::timestamptz - make_interval(days => $3::int)
          and e.received_at <= $2::timestamptz
        group by e.error_fingerprint
        order by is_new desc, count desc, fingerprint
        limit 100
      `,
      [since, until, config.baselineDays]
    )
  ]);
  const totals = totalsResult.rows[0] ?? {};

  return {
    window,
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
      isNew: row.is_new === true,
      countLastDay: toNumber(row.count_last_day),
      countLastDayBeforeWindow: toNumber(row.count_last_day_before_window)
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
    (group) =>
      group.isNew &&
      group.countLastDay >= config.newErrorMinCount &&
      group.countLastDayBeforeWindow < config.newErrorMinCount
  );
  // A catch-up window longer than the usual one gets a proportionally higher spike threshold.
  const spikeThreshold = Math.ceil(
    config.minErrors * Math.max(1, snapshot.window.minutes / config.windowMinutes)
  );

  if (snapshot.fatal > 0) {
    reasons.push(`${plural(snapshot.fatal, "fatal error")} (app crashes)`);
  }

  if (snapshot.total >= spikeThreshold) {
    reasons.push(
      `${plural(snapshot.total, "error")} in ${plural(snapshot.window.minutes, "minute")} ` +
        `(alert threshold ${spikeThreshold})`
    );
  }

  if (newGroups.length > 0) {
    reasons.push(
      `${plural(newGroups.length, "new error")} first seen in the last 24 hours ` +
        `(none in the ${plural(config.baselineDays, "day")} before)`
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
  runUrl?: string
): ErrorAlertMessage => {
  const topGroups = [...snapshot.groups]
    .sort((left, right) => right.count - left.count)
    .slice(0, 10);
  const newGroupsOutsideTop = decision.newGroups.filter((group) => !topGroups.includes(group));

  return {
    subject: `LinkDish error alert: ${decision.reasons[0] ?? "errors"}`,
    text: [
      `LinkDish error alert for the last ${plural(snapshot.window.minutes, "minute")}.`,
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

const SEND_TIMEOUT_MS = 10_000;

/*
 * Error messages come from clients, so they must not ping anyone or render as links: Discord gets
 * `allowed_mentions: { parse: [] }` and no embeds, and Slack-style text has its control characters
 * escaped, which turns <!channel> and <url|label> into plain text.
 */
export const buildWebhookPayload = (webhookUrl: string, text: string): Record<string, unknown> => {
  try {
    const hostname = new URL(webhookUrl).hostname;

    if (/(^|\.)discord(app)?\.com$/.test(hostname)) {
      return { content: text, allowed_mentions: { parse: [] }, flags: 4 };
    }
  } catch {
    // Fall through to the Slack-style payload.
  }

  return {
    text: text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  };
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
        }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS)
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
        body: JSON.stringify(buildWebhookPayload(channels.webhookUrl, text)),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS)
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
