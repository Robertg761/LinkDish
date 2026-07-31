import { randomBytes } from "node:crypto";

import { z, ZodError } from "zod";

import { extractorApiEnv } from "../services/extractor-api/src/config/env.js";
import { corsJson, corsPreflight } from "../services/extractor-api/src/http/vercel-cors.js";
import {
  checkPublicEndpointRateLimit,
  RateLimitUnavailableError
} from "../services/extractor-api/src/modules/rate-limit/enforce-rate-limit.js";

export const config = {
  maxDuration: 30
};

const maxTextLength = 4_000;
const supportTicketRateLimitPolicy = {
  max: 5,
  scope: "support-ticket",
  windowMs: 60 * 60 * 1_000
} as const;
const supportEmailTo = process.env.SUPPORT_EMAIL_TO?.trim() || "support@linkdish.ca";
const supportEmailFrom =
  process.env.SUPPORT_EMAIL_FROM?.trim() ||
  extractorApiEnv.IOS_WAITLIST_EMAIL_FROM ||
  extractorApiEnv.AUTH_EMAIL_FROM;

const supportTicketSchema = z.object({
  device: z.string().trim().max(300).optional(),
  email: z.string().trim().email().max(254),
  expected: z.string().trim().max(maxTextLength).optional(),
  link: z.string().trim().url().max(2_048).optional().or(z.literal("")),
  problemType: z
    .enum([
      "Recipe import problem",
      "Account or household issue",
      "Web app bug",
      "Privacy or data request",
      "Other"
    ])
    .default("Other"),
  details: z.string().trim().min(10).max(maxTextLength),
  website: z.string().trim().max(0).optional()
});

type SupportTicketPayload = z.infer<typeof supportTicketSchema>;

class SupportTicketError extends Error {
  public constructor(
    message: string,
    public readonly statusCode = 400
  ) {
    super(message);
    this.name = "SupportTicketError";
  }
}

const createTicketId = (): string =>
  `LD-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomBytes(4)
    .toString("hex")
    .toUpperCase()}`;

const escapeHtml = (value: string): string =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const optionalValue = (value: string | undefined): string =>
  value && value.length > 0 ? value : "Not provided";

const buildEmailText = (ticketId: string, payload: SupportTicketPayload): string =>
  [
    `Ticket: ${ticketId}`,
    `Problem type: ${payload.problemType}`,
    `Email: ${payload.email}`,
    `Recipe or page link: ${optionalValue(payload.link)}`,
    `Device and browser/app: ${optionalValue(payload.device)}`,
    "",
    "What happened:",
    payload.details,
    "",
    "What the customer expected:",
    optionalValue(payload.expected)
  ].join("\n");

const buildEmailHtml = (ticketId: string, payload: SupportTicketPayload): string => {
  const rows: Array<[string, string]> = [
    ["Ticket", ticketId],
    ["Problem type", payload.problemType],
    ["Email", payload.email],
    ["Recipe or page link", optionalValue(payload.link)],
    ["Device and browser/app", optionalValue(payload.device)]
  ];

  return [
    "<h1>New LinkDish support ticket</h1>",
    "<table>",
    rows
      .map(
        ([label, value]) =>
          `<tr><td><strong>${escapeHtml(label)}</strong></td><td>${escapeHtml(value)}</td></tr>`
      )
      .join(""),
    "</table>",
    "<h2>What happened</h2>",
    `<p>${escapeHtml(payload.details).replaceAll("\n", "<br>")}</p>`,
    "<h2>What the customer expected</h2>",
    `<p>${escapeHtml(optionalValue(payload.expected)).replaceAll("\n", "<br>")}</p>`
  ].join("");
};

const sendSupportTicketEmail = async (
  ticketId: string,
  payload: SupportTicketPayload
): Promise<void> => {
  if (!extractorApiEnv.RESEND_API_KEY || !supportEmailFrom) {
    if (extractorApiEnv.NODE_ENV !== "production") {
      console.info(`LinkDish support ticket ${ticketId}`, buildEmailText(ticketId, payload));
      return;
    }

    throw new SupportTicketError("Support ticket email is not configured.", 503);
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${extractorApiEnv.RESEND_API_KEY}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      from: supportEmailFrom,
      html: buildEmailHtml(ticketId, payload),
      reply_to: payload.email,
      subject: `[${ticketId}] LinkDish support: ${payload.problemType}`,
      text: buildEmailText(ticketId, payload),
      to: supportEmailTo
    })
  });

  if (!response.ok) {
    throw new SupportTicketError("LinkDish could not submit the support ticket right now.", 503);
  }
};

const parseJsonBody = async (request: Request): Promise<unknown> => {
  try {
    return await request.json();
  } catch {
    throw new SupportTicketError("Request body must be valid JSON.", 400);
  }
};

const errorResponse = (request: Request, error: unknown): Response =>
  corsJson(
    request,
    {
      message:
        error instanceof ZodError
          ? "Check the support form and try again."
          : error instanceof Error
            ? error.message
            : "Unexpected support ticket error."
    },
    {
      status:
        error instanceof SupportTicketError
          ? error.statusCode
          : error instanceof ZodError
            ? 400
            : 500
    }
  );

export function OPTIONS(request: Request) {
  return corsPreflight(request);
}

export async function POST(request: Request) {
  try {
    const rateLimit = await checkPublicEndpointRateLimit(
      request.headers,
      supportTicketRateLimitPolicy
    );

    if (!rateLimit.allowed) {
      return corsJson(
        request,
        {
          message: "Too many support requests. Please try again later."
        },
        {
          headers: rateLimit.headers,
          status: 429
        }
      );
    }

    const payload = supportTicketSchema.parse(await parseJsonBody(request));
    const ticketId = createTicketId();
    await sendSupportTicketEmail(ticketId, payload);

    return corsJson(
      request,
      {
        status: "submitted",
        ticketId
      },
      {
        status: 200
      }
    );
  } catch (error) {
    if (error instanceof RateLimitUnavailableError) {
      return corsJson(
        request,
        {
          message: "Support requests are temporarily unavailable. Please try again later."
        },
        {
          status: 503
        }
      );
    }

    return errorResponse(request, error);
  }
}
