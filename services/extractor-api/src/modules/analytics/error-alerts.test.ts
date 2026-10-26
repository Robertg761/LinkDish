import { describe, expect, it, vi } from "vitest";

import {
  buildWebhookPayload,
  decideErrorAlert,
  formatErrorAlert,
  loadErrorAlertSnapshot,
  readErrorAlertChannels,
  readErrorAlertConfig,
  sendErrorAlert,
  type ErrorAlertGroup,
  type ErrorAlertSnapshot
} from "./error-alerts.js";

const config = readErrorAlertConfig({});

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
  ...overrides
});

const snapshot = (groups: ErrorAlertGroup[]): ErrorAlertSnapshot => ({
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

  it("alerts on any fatal error", () => {
    const decision = decideErrorAlert(
      snapshot([group({ platform: "android", count: 1, fatalCount: 1 })]),
      config
    );

    expect(decision.reasons).toEqual(["1 fatal error (app crashes)"]);
  });

  it("alerts on a new error once it repeats enough", () => {
    expect(decideErrorAlert(snapshot([group({ isNew: true, count: 2 })]), config).shouldAlert).toBe(
      false
    );

    const decision = decideErrorAlert(snapshot([group({ isNew: true, count: 3 })]), config);

    expect(decision.reasons).toEqual(["1 new error not seen in the previous 7 days"]);
    expect(decision.newGroups).toHaveLength(1);
  });
});

describe("formatErrorAlert", () => {
  it("lists reasons and the most frequent errors", () => {
    const current = snapshot([
      group({ count: 30, visitors: 4 }),
      group({
        fingerprint: "android:native:boom",
        platform: "android",
        message: "boom",
        routeOrScreen: "native",
        count: 1,
        fatalCount: 1,
        isNew: true
      })
    ]);
    const message = formatErrorAlert(
      current,
      decideErrorAlert(current, { ...config, newErrorMinCount: 1 }),
      config,
      "https://github.com/o/r/actions/runs/1"
    );

    expect(message.subject).toBe("LinkDish error alert: 1 fatal error (app crashes)");
    expect(message.text).toContain("* 31 errors in 60 minutes (alert threshold 25)");
    expect(message.text).toContain(
      "- 30x TypeError: x is undefined (web, /recipes, v2.1.0, 4 visitors)"
    );
    expect(message.text).toContain("- 1x boom (android, native, v2.1.0, 1 visitor, 1 fatal, new)");
    expect(message.text).toContain("Workflow run: https://github.com/o/r/actions/runs/1");
  });
});

describe("loadErrorAlertSnapshot", () => {
  it("windows on received_at and maps rows", async () => {
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
            is_new: true
          }
        ]
      });

    await expect(loadErrorAlertSnapshot({ query }, config)).resolves.toEqual({
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
          isNew: true
        }
      ]
    });
    expect(String(query.mock.calls[0]?.[0])).toContain("received_at >= now()");
    expect(query.mock.calls[1]?.[1]).toEqual([60, 7]);
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
  it("uses Discord's content field and Slack's text field", () => {
    expect(buildWebhookPayload("https://discord.com/api/webhooks/1/abc", "hi")).toEqual({
      content: "hi"
    });
    expect(buildWebhookPayload("https://hooks.slack.com/services/x", "hi")).toEqual({
      text: "hi"
    });
  });
});
