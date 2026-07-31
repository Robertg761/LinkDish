import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const resendEmailRequestSchema = z.object({
  from: z.string(),
  subject: z.string(),
  text: z.string(),
  to: z.string()
});

const importWaitlistService = async () => {
  vi.resetModules();
  vi.stubEnv("AUTH_SECRET", "test_auth_secret");
  vi.stubEnv("BILLING_QUOTA_IDENTITY_SECRET", "test_identity_secret");
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://upstash.invalid");
  vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");

  return import("./ios-waitlist-service.js");
};

beforeEach(() => {
  vi.useFakeTimers({
    now: new Date("2026-05-14T12:00:00.000Z")
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("ios-waitlist-service", () => {
  it("stores normalized emails and treats duplicate joins as already joined", async () => {
    const waitlist = await importWaitlistService();
    const headers = new Headers({
      "user-agent": "vitest",
      "x-forwarded-for": "203.0.113.4"
    });

    await expect(
      waitlist.joinIosWaitlist(
        {
          email: " IOS.User+Beta@Example.COM ",
          source: "website-ios-section"
        },
        headers
      )
    ).resolves.toMatchObject({
      alreadyJoined: false,
      email: "ios.user+beta@example.com",
      status: "joined"
    });

    await expect(
      waitlist.joinIosWaitlist(
        {
          email: "ios.user+beta@example.com",
          source: "website-ios-section"
        },
        headers
      )
    ).resolves.toMatchObject({
      alreadyJoined: true,
      email: "ios.user+beta@example.com",
      status: "joined"
    });
  });

  it("sends a confirmation email for new waitlist signups", async () => {
    vi.stubEnv("RESEND_API_KEY", "resend_test");
    vi.stubEnv("AUTH_EMAIL_FROM", "LinkDish <hello@example.com>");
    vi.stubEnv("IOS_WAITLIST_EMAIL_FROM", "LinkDish <ios@example.com>");
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Promise.resolve(new Response(JSON.stringify({ id: "email_123" })))
    );
    vi.stubGlobal("fetch", fetchMock);

    const waitlist = await importWaitlistService();

    await expect(
      waitlist.joinIosWaitlist({ email: "ios.user@example.com" }, new Headers())
    ).resolves.toMatchObject({
      alreadyJoined: false,
      email: "ios.user@example.com",
      status: "joined"
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.resend.com/emails",
      expect.objectContaining({
        method: "POST"
      })
    );

    const request = fetchMock.mock.calls[0]?.[1];
    if (typeof request?.body !== "string") {
      throw new Error("Expected waitlist email request body to be a JSON string.");
    }

    const body = resendEmailRequestSchema.parse(JSON.parse(request.body) as unknown);

    expect(body.from).toBe("LinkDish <ios@example.com>");
    expect(body.subject).toBe("You are on the LinkDish iOS waitlist");
    expect(body.text).toContain("Thanks for joining the LinkDish iOS waitlist.");
    expect(body.to).toBe("ios.user@example.com");
  });

  it("does not fail signup when the confirmation email cannot be sent", async () => {
    vi.stubEnv("RESEND_API_KEY", "resend_test");
    vi.stubEnv("AUTH_EMAIL_FROM", "LinkDish <hello@example.com>");
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => Promise.resolve(new Response("unavailable", { status: 503 })))
    );
    const warnMock = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const waitlist = await importWaitlistService();

    await expect(
      waitlist.joinIosWaitlist({ email: "ios.user@example.com" }, new Headers())
    ).resolves.toMatchObject({
      alreadyJoined: false,
      email: "ios.user@example.com",
      status: "joined"
    });

    expect(warnMock).toHaveBeenCalledWith(
      "Failed to send LinkDish iOS waitlist confirmation email.",
      expect.any(Error)
    );
  });

  it("does not resend confirmation emails for duplicate joins", async () => {
    vi.stubEnv("RESEND_API_KEY", "resend_test");
    vi.stubEnv("AUTH_EMAIL_FROM", "LinkDish <hello@example.com>");
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Promise.resolve(new Response(JSON.stringify({ id: "email_123" })))
    );
    vi.stubGlobal("fetch", fetchMock);
    const waitlist = await importWaitlistService();

    await waitlist.joinIosWaitlist({ email: "ios.user@example.com" }, new Headers());
    await expect(
      waitlist.joinIosWaitlist({ email: "ios.user@example.com" }, new Headers())
    ).resolves.toMatchObject({
      alreadyJoined: true,
      email: "ios.user@example.com",
      status: "joined"
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns waitlist signups for the admin dashboard newest first", async () => {
    const waitlist = await importWaitlistService();

    await waitlist.joinIosWaitlist(
      {
        email: "first@example.com",
        source: "footer"
      },
      new Headers({
        "user-agent": "first test browser"
      })
    );

    vi.setSystemTime(new Date("2026-05-14T12:05:00.000Z"));

    await waitlist.joinIosWaitlist(
      {
        email: "second@example.com",
        source: "ios-section"
      },
      new Headers({
        "user-agent": "second test browser"
      })
    );

    const snapshot = await waitlist.getIosWaitlistSnapshot();

    expect(snapshot).toMatchObject({
      hasMore: false,
      total: 2
    });
    expect(snapshot.entries).toMatchObject([
      {
        createdAt: "2026-05-14T12:05:00.000Z",
        email: "second@example.com",
        source: "ios-section",
        userAgent: "second test browser"
      },
      {
        createdAt: "2026-05-14T12:00:00.000Z",
        email: "first@example.com",
        source: "footer",
        userAgent: "first test browser"
      }
    ]);
  });

  it("rejects invalid emails", async () => {
    const waitlist = await importWaitlistService();

    await expect(
      waitlist.joinIosWaitlist({ email: "not-an-email" }, new Headers())
    ).rejects.toMatchObject({
      name: "ZodError"
    });
  });

  it("rate limits repeated signups from the same network identity", async () => {
    const waitlist = await importWaitlistService();
    const [{ getStoreSortedSetCount }, { hashServerSideIdentity }] = await Promise.all([
      import("../storage/upstash-store.js"),
      import("../request-identity.js")
    ]);
    const address = "203.0.113.8";
    const headers = new Headers({
      "x-forwarded-for": address
    });
    const rateLimitKey = waitlist.iosWaitlistKeys.rateLimit(
      hashServerSideIdentity("ios-waitlist", address)
    );

    for (let index = 0; index < 5; index += 1) {
      await waitlist.joinIosWaitlist({ email: `user${index}@example.com` }, headers);
    }

    await expect(getStoreSortedSetCount(rateLimitKey)).resolves.toBe(5);

    for (let index = 5; index < 10; index += 1) {
      await expect(
        waitlist.joinIosWaitlist({ email: `user${index}@example.com` }, headers)
      ).rejects.toMatchObject({
        message: "Too many waitlist requests. Please try again later.",
        statusCode: 429
      });
    }

    await expect(getStoreSortedSetCount(rateLimitKey)).resolves.toBe(5);
  });

  it("expires idle waitlist rate-limit keys after the window", async () => {
    const waitlist = await importWaitlistService();
    const [{ getStoreSortedSetCount }, { hashServerSideIdentity }] = await Promise.all([
      import("../storage/upstash-store.js"),
      import("../request-identity.js")
    ]);
    const address = "203.0.113.9";
    const headers = new Headers({
      "x-forwarded-for": address
    });
    const rateLimitKey = waitlist.iosWaitlistKeys.rateLimit(
      hashServerSideIdentity("ios-waitlist", address)
    );

    await waitlist.joinIosWaitlist({ email: "expires@example.com" }, headers);
    await expect(getStoreSortedSetCount(rateLimitKey)).resolves.toBe(1);

    vi.setSystemTime(new Date("2026-05-14T13:00:01.000Z"));

    await expect(getStoreSortedSetCount(rateLimitKey)).resolves.toBe(0);
  });
});
