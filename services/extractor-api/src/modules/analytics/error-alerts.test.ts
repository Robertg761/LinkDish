import { describe, expect, it, vi } from "vitest";

import {
  buildWebhookPayload,
  decideErrorAlert,
  formatErrorAlert,
  loadErrorAlertSnapshot,
  loadErrorAlertWindow,
  readErrorAlertChannels,
  readErrorAlertConfig,
  sendErrorAlert,
  type ErrorAlertGroup,
  type ErrorAlertSnapshot,
  type ErrorAlertWindow
} from "./error-alerts.js";

const config = readErrorAlertConfig({});

const hourWindow: ErrorAlertWindow = {
  since: new Date("2026-10-26T09:17:00.000Z"),
  until: new Date("2026-10-26T10:17:00.000Z"),
  minutes: 60
};

const group = (overrides: Partial<ErrorAlertGroup> = {}): ErrorAlertGroup => ({
  fingerprint: "web:/recipes:TypeError: x is undefined",
  platform: "web",
  count: 1,
  fatalCount: 0,
  visitors: 1,
  message: "TypeError: x is undefined",
  routeOrScreen: "/recipes",
  appVersion: "2.1.0",
  isNew: false,
  countLastDay: 1,
  countLastDayBeforeWindow: 0,
  ...overrides
});

const snapshot = (
  groups: ErrorAlertGroup[],
  window: ErrorAlertWindow = hourWindow
): ErrorAlertSnapshot => ({
  window,
  total: groups.reduce((sum, item) => sum + item.count, 0),
  fatal: groups.reduce((sum, item) => sum + item.fatalCount, 0),
  groups
});

describe("readErrorAlertConfig", () => {
  it("uses defaults and ignores invalid overrides", () => {
    expect(config).toEqual({
      windowMinutes: 60,
      minErrors: 25,
      newErrorMinCount: 3,
      baselineDays: 7
    });
    expect(
      readErrorAlertConfig({
        ERROR_ALERT_WINDOW_MINUTES: "90",
        ERROR_ALERT_MIN_ERRORS: "0",
        ERROR_ALERT_NEW_ERROR_MIN_COUNT: "lots"
      })
    ).toEqual({ windowMinutes: 90, minErrors: 25, newErrorMinCount: 3, baselineDays: 7 });
  });
});

describe("readErrorAlertChannels", () => {
  it("reads email recipients and falls back to the auth sender", () => {
    expect(
      readErrorAlertChannels({
        RESEND_API_KEY: "re_123",
        AUTH_EMAIL_FROM: "LinkDish <hello@linkdish.ca>",
        ERROR_ALERT_EMAIL_TO: " a@example.com, ,b@example.com ",
        ERROR_ALERT_WEBHOOK_URL: " "
      })
    ).toEqual({
      resendApiKey: "re_123",
      emailFrom: "LinkDish <hello@linkdish.ca>",
      emailTo: ["a@example.com", "b@example.com"]
    });
  });
});

describe("loadErrorAlertWindow", () => {
  const queryReturning = (row: Record<string, unknown>) =>
    vi.fn().mockResolvedValue({ rows: [row] });

  it("covers the configured window on the first run", async () => {
    const query = queryReturning({ until: hourWindow.until, checked_until: null });

    await expect(loadErrorAlertWindow({ query }, config)).resolves.toEqual(hourWindow);
  });

  it("starts where the last finished run stopped, so late runs miss nothing", async () => {
    const query = queryReturning({
      until: new Date("2026-10-26T11:45:00.000Z"),
      checked_until: "2026-10-26T10:17:00.000Z"
    });

    await expect(loadErrorAlertWindow({ query }, config)).resolves.toEqual({
      since: new Date("2026-10-26T10:17:00.000Z"),
      until: new Date("2026-10-26T11:45:00.000Z"),
      minutes: 88
    });
  });

  it("catches up at most one day", async () => {
    const query = queryReturning({
      until: new Date("2026-10-26T10:00:00.000Z"),
      checked_until: new Date("2026-10-20T10:00:00.000Z")
    });

    await expect(loadErrorAlertWindow({ query }, config)).resolves.toMatchObject({
      since: new Date("2026-10-25T10:00:00.000Z"),
      minutes: 1_440
    });
  });
});

describe("decideErrorAlert", () => {
  it("stays quiet for a few known errors", () => {
    expect(decideErrorAlert(snapshot([group({ count: 5 })]), config)).toEqual({
      shouldAlert: false,
      reasons: [],
      newGroups: []
    });
  });

  it("alerts on a spike above the threshold", () => {
    const decision = decideErrorAlert(snapshot([group({ count: 25 })]), config);

    expect(decision.shouldAlert).toBe(true);
    expect(decision.reasons).toEqual(["25 errors in 60 minutes (alert threshold 25)"]);
  });

  it("scales the spike threshold for a longer catch-up window", () => {
    const longWindow = { ...hourWindow, minutes: 150 };

    expect(decideErrorAlert(snapshot([group({ count: 60 })], longWindow), config).shouldAlert).toBe(
      false
    );
    expect(decideErrorAlert(snapshot([group({ count: 63 })], longWindow), config).reasons).toEqual([
      "63 errors in 150 minutes (alert threshold 63)"
    ]);
  });

  it("alerts on any fatal error", () => {
    const decision = decideErrorAlert(
      snapshot([group({ platform: "android", count: 1, fatalCount: 1 })]),
      config
    );

    expect(decision.reasons).toEqual(["1 fatal error (app crashes)"]);
  });

  it("alerts once, in the run where a new error reaches the threshold", () => {
    expect(
      decideErrorAlert(snapshot([group({ isNew: true, count: 2, countLastDay: 2 })]), config)
        .shouldAlert
    ).toBe(false);

    // One occurrence fell in the previous run's window and five in this one.
    const decision = decideErrorAlert(
      snapshot([group({ isNew: true, count: 5, countLastDay: 6, countLastDayBeforeWindow: 1 })]),
      config
    );

    expect(decision.reasons).toEqual([
      "1 new error first seen in the last 24 hours (none in the 7 days before)"
    ]);
    expect(decision.newGroups).toHaveLength(1);

    // Already over the threshold before this window: reported by an earlier run.
    expect(
      decideErrorAlert(
        snapshot([group({ isNew: true, count: 2, countLastDay: 6, countLastDayBeforeWindow: 4 })]),
        config
      ).shouldAlert
    ).toBe(false);
  });
});

describe("formatErrorAlert", () => {
  it("lists reasons and the most frequent errors", () => {
    const newCrash = group({
      fingerprint: "android:native:boom",
      platform: "android",
      message: "boom",
      routeOrScreen: "native",
      count: 1,
      fatalCount: 1,
      isNew: true
    });
    // New errors sort first in the query; the message still lists by count.
    const current = snapshot([newCrash, group({ count: 30, visitors: 4 })]);
    const message = formatErrorAlert(
      current,
      decideErrorAlert(current, { ...config, newErrorMinCount: 1 }),
      "https://github.com/o/r/actions/runs/1"
    );

    expect(message.subject).toBe("LinkDish error alert: 1 fatal error (app crashes)");
    expect(message.text).toContain("LinkDish error alert for the last 60 minutes.");
    expect(message.text).toContain("* 31 errors in 60 minutes (alert threshold 25)");
    expect(message.text).toContain(
      "- 30x TypeError: x is undefined (web, /recipes, v2.1.0, 4 visitors)\n" +
        "- 1x boom (android, native, v2.1.0, 1 visitor, 1 fatal, new)"
    );
    expect(message.text).toContain("Workflow run: https://github.com/o/r/actions/runs/1");
  });
});

describe("loadErrorAlertSnapshot", () => {
  it("queries the window on received_at and maps rows", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ total: 4, fatal: "1" }] })
      .mockResolvedValueOnce({
        rows: [
          {
            fingerprint: "android:native:boom",
            platform: "android",
            count: 4,
            fatal_count: 1,
            visitors: "2",
            message: "boom",
            route_or_screen: "native",
            app_version: null,
            is_new: true,
            count_last_day: 5,
            count_last_day_before_window: "1"
          }
        ]
      });

    await expect(loadErrorAlertSnapshot({ query }, config, hourWindow)).resolves.toEqual({
      window: hourWindow,
      total: 4,
      fatal: 1,
      groups: [
        {
          fingerprint: "android:native:boom",
          platform: "android",
          count: 4,
          fatalCount: 1,
          visitors: 2,
          message: "boom",
          routeOrScreen: "native",
          appVersion: null,
          isNew: true,
          countLastDay: 5,
          countLastDayBeforeWindow: 1
        }
      ]
    });
    expect(String(query.mock.calls[0]?.[0])).toContain("received_at > $1::timestamptz");
    expect(query.mock.calls[1]?.[1]).toEqual([
      "2026-10-26T09:17:00.000Z",
      "2026-10-26T10:17:00.000Z",
      7
    ]);
  });
});

type FetchMock = (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number }>;

describe("sendErrorAlert", () => {
  const message = { subject: "LinkDish error alert", text: "x".repeat(2_500) };

  it("sends email through Resend and a trimmed message to the webhook", async () => {
    const fetchImpl = vi.fn<FetchMock>().mockResolvedValue({ ok: true, status: 200 });

    await expect(
      sendErrorAlert(
        message,
        {
          resendApiKey: "re_123",
          emailFrom: "alerts@linkdish.ca",
          emailTo: ["robert@example.com"],
          webhookUrl: "https://discord.com/api/webhooks/1/abc"
        },
        fetchImpl
      )
    ).resolves.toEqual({ sent: ["email", "webhook"], failed: [] });

    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://api.resend.com/emails");
    expect(fetchImpl.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(fetchImpl.mock.calls[1]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    const webhookBody = JSON.parse(fetchImpl.mock.calls[1]?.[1]?.body as string) as {
      content: string;
    };
    expect(webhookBody.content.length).toBeLessThan(2_000);
  });

  it("reports failed channels without throwing", async () => {
    const fetchImpl = vi
      .fn<FetchMock>()
      .mockResolvedValueOnce({ ok: false, status: 403 })
      .mockRejectedValueOnce(new Error("offline"));

    await expect(
      sendErrorAlert(
        message,
        {
          resendApiKey: "re_123",
          emailFrom: "alerts@linkdish.ca",
          emailTo: ["robert@example.com"],
          webhookUrl: "https://hooks.slack.com/services/x"
        },
        fetchImpl
      )
    ).resolves.toEqual({ sent: [], failed: ["email (HTTP 403)", "webhook"] });
  });
});

describe("buildWebhookPayload", () => {
  const hostile = "@everyone <!channel> <https://evil.example|free recipes> & more";

  it("stops Discord from pinging or embedding client text", () => {
    expect(buildWebhookPayload("https://discord.com/api/webhooks/1/abc", hostile)).toEqual({
      content: hostile,
      allowed_mentions: { parse: [] },
      flags: 4
    });
  });

  it("escapes Slack control characters so mentions and links stay plain text", () => {
    expect(buildWebhookPayload("https://hooks.slack.com/services/x", hostile)).toEqual({
      text: "@everyone &lt;!channel&gt; &lt;https://evil.example|free recipes&gt; &amp; more"
    });
  });
});
