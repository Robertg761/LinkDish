import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as SupportTicketModule from "./support-ticket.js";

type SupportTicketApi = typeof SupportTicketModule;

let supportTicketApi: SupportTicketApi;
let mockFetch: ReturnType<typeof vi.fn>;
let consoleInfoSpy: ReturnType<typeof vi.spyOn>;

const request = (body: unknown, headers?: Record<string, string>) =>
  new Request("https://api.linkdish.ca/support-ticket", {
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      origin: "https://linkdish.ca",
      ...headers
    },
    method: "POST"
  });

const validPayload = {
  device: "iPhone Safari",
  email: "customer@example.com",
  expected: "The ingredients should include quantities.",
  link: "https://example.com/recipe",
  problemType: "Recipe import problem",
  details: "The ingredient list imported without quantities."
};

beforeEach(async () => {
  vi.resetModules();
  vi.stubEnv("AUTH_EMAIL_FROM", "LinkDish <support@linkdish.ca>");
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("RESEND_API_KEY", "resend_test");
  vi.stubEnv("SUPPORT_EMAIL_TO", "support@linkdish.ca");
  mockFetch = vi.fn(() =>
    Promise.resolve(
      new Response(JSON.stringify({ id: "email_123" }), {
        headers: {
          "content-type": "application/json"
        },
        status: 200
      })
    )
  );
  vi.stubGlobal("fetch", mockFetch);
  consoleInfoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
  supportTicketApi = await import("./support-ticket.js");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Vercel support ticket adapter", () => {
  it("sends a support ticket email and returns a ticket id", async () => {
    const response = await supportTicketApi.POST(request(validPayload));
    const body = (await response.json()) as { status: string; ticketId: string };

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://linkdish.ca");
    expect(body).toMatchObject({
      status: "submitted"
    });
    expect(body.ticketId).toMatch(/^LD-\d{8}-[A-F0-9]{8}$/u);
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.resend.com/emails",
      expect.objectContaining({
        method: "POST"
      })
    );

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const resendBody = JSON.parse(init.body as string) as {
      from: string;
      reply_to: string;
      subject: string;
      text: string;
      to: string;
    };

    expect(resendBody).toMatchObject({
      from: "LinkDish <support@linkdish.ca>",
      reply_to: "customer@example.com",
      to: "support@linkdish.ca"
    });
    expect(resendBody.subject).toContain("LinkDish support: Recipe import problem");
    expect(resendBody.text).toContain("The ingredient list imported without quantities.");
  });

  it("rejects invalid support ticket payloads without sending email", async () => {
    const response = await supportTicketApi.POST(
      request({
        ...validPayload,
        details: "too short",
        email: "not-an-email"
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      message: "Check the support form and try again."
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("rate limits repeated support ticket submissions", async () => {
    let latestResponse: Response | undefined;

    for (let index = 0; index < 6; index += 1) {
      latestResponse = await supportTicketApi.POST(
        request(
          {
            ...validPayload,
            email: `customer${index}@example.com`
          },
          {
            "x-forwarded-for": "203.0.113.72"
          }
        )
      );
    }

    expect(latestResponse?.status).toBe(429);
    await expect(latestResponse?.json()).resolves.toEqual({
      message: "Too many support requests. Please try again later."
    });
    expect(mockFetch).toHaveBeenCalledTimes(5);
  });

  it("logs support tickets outside production when email is not configured", async () => {
    vi.stubEnv("AUTH_EMAIL_FROM", "");
    vi.stubEnv("RESEND_API_KEY", "");
    vi.resetModules();
    supportTicketApi = await import("./support-ticket.js");

    const response = await supportTicketApi.POST(request(validPayload));

    expect(response.status).toBe(200);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(consoleInfoSpy).toHaveBeenCalledWith(
      expect.stringMatching(/^LinkDish support ticket LD-\d{8}-[A-F0-9]{8}$/u),
      expect.stringContaining("customer@example.com")
    );
  });

  it("serves a CORS preflight for the public support site", () => {
    const response = supportTicketApi.OPTIONS(
      new Request("https://api.linkdish.ca/support-ticket", {
        headers: {
          origin: "https://linkdish.ca"
        },
        method: "OPTIONS"
      })
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://linkdish.ca");
    expect(response.headers.get("access-control-allow-methods")).toContain("POST");
  });
});
