import { describe, expect, it } from "vitest";

import {
  analyticsEventBatchRequestSchema,
  analyticsEventPropertiesSchema,
  extractRecipeRequestSchema,
  householdInviteShareSchema,
  MAX_ANALYTICS_EVENT_PROPERTY_COUNT,
  MAX_IMAGE_EXTRACT_PAYLOAD_CHARS,
  MAX_IMAGE_DATA_URL_CHARS,
  webBillingRedirectResponseSchema
} from "./index.js";

const dangerousUrls = [
  "javascript:alert(1)",
  "data:text/html,<script>alert(1)</script>",
  "file:///etc/passwd",
  "vbscript:msgbox(1)",
  "http://user:pass@evil.com@good.com/"
];

const buildDataUrl = (length: number): string => {
  const prefix = "data:image/jpeg;base64,";
  return prefix + "a".repeat(Math.max(1, length - prefix.length));
};

describe("extract request url hardening", () => {
  it("rejects dangerous extraction target urls", () => {
    for (const url of dangerousUrls) {
      expect(extractRecipeRequestSchema.safeParse({ url }).success).toBe(false);
    }
  });

  it("rejects dangerous image import source urls", () => {
    for (const sourceUrl of dangerousUrls) {
      expect(
        extractRecipeRequestSchema.safeParse({
          images: [{ dataUrl: "data:image/jpeg;base64,abc123", mimeType: "image/jpeg" }],
          sourceUrl
        }).success
      ).toBe(false);
    }
  });

  it("still accepts ordinary https extraction targets", () => {
    expect(
      extractRecipeRequestSchema.safeParse({ url: "https://example.com/recipes/1" }).success
    ).toBe(true);
  });
});

describe("billing redirect hardening", () => {
  it("rejects open-redirect targets", () => {
    for (const url of [...dangerousUrls, "https://evil.example.com/checkout"]) {
      expect(webBillingRedirectResponseSchema.safeParse({ url }).success).toBe(false);
    }
  });

  it("accepts the billing providers LinkDish actually redirects to", () => {
    for (const url of [
      "https://pay.rev.cat/test/user_family?email=family%40example.com",
      "https://billing.revenuecat.com/portal/abc",
      "https://app.linkdish.ca/account"
    ]) {
      expect(webBillingRedirectResponseSchema.safeParse({ url }).success).toBe(true);
    }
  });
});

describe("household invite url hardening", () => {
  const invite = {
    id: "invite_1",
    email: "member@example.com",
    expiresAt: "2026-05-12T00:00:00.000Z",
    inviteCode: "invite-code-1234"
  };

  it("rejects invite urls pointing off LinkDish domains", () => {
    for (const inviteUrl of [...dangerousUrls, "https://evil.example.com/invite/?code=abc"]) {
      expect(householdInviteShareSchema.safeParse({ ...invite, inviteUrl }).success).toBe(false);
    }
  });

  it("accepts LinkDish invite urls", () => {
    expect(
      householdInviteShareSchema.safeParse({
        ...invite,
        inviteUrl: "https://linkdish.ca/invite/?code=invite-code-1234"
      }).success
    ).toBe(true);
  });
});

describe("analytics property bounds", () => {
  it("rejects property bags with too many keys", () => {
    const properties = Object.fromEntries(
      Array.from({ length: MAX_ANALYTICS_EVENT_PROPERTY_COUNT + 1 }, (_unused, index) => [
        `key_${index}`,
        index
      ])
    );

    expect(analyticsEventPropertiesSchema.safeParse(properties).success).toBe(false);
  });

  it("rejects property bags that are too large overall", () => {
    const properties = Object.fromEntries(
      Array.from({ length: 20 }, (_unused, index) => [`key_${index}`, "v".repeat(500)])
    );

    expect(analyticsEventPropertiesSchema.safeParse(properties).success).toBe(false);
  });

  it("still accepts realistic analytics properties", () => {
    const parsed = analyticsEventBatchRequestSchema.safeParse({
      events: [
        {
          eventName: "import_started",
          platform: "web_app",
          properties: {
            source_type: "url",
            source_host: "example.com",
            attempt: "primary",
            step_count: 12,
            is_retry: false,
            note: null
          }
        }
      ]
    });

    expect(parsed.success).toBe(true);
  });
});

describe("image extraction payload bounds", () => {
  it("caps a single image data url", () => {
    expect(
      extractRecipeRequestSchema.safeParse({
        images: [{ dataUrl: buildDataUrl(MAX_IMAGE_DATA_URL_CHARS + 1), mimeType: "image/jpeg" }],
        sourceUrl: "https://linkdish.ca/image-imports/test"
      }).success
    ).toBe(false);
  });

  it("rejects an oversized aggregate payload before validating image contents", () => {
    const oversizedImage = {
      // Deliberately not base64: if the regex ran first this would be rejected for the wrong
      // reason (and only after scanning megabytes of input).
      dataUrl: `data:image/jpeg;base64,${"\u0000".repeat(MAX_IMAGE_EXTRACT_PAYLOAD_CHARS / 3)}`,
      mimeType: "image/jpeg"
    };

    const parsed = extractRecipeRequestSchema.safeParse({
      images: [oversizedImage, oversizedImage, oversizedImage, oversizedImage],
      sourceUrl: "https://linkdish.ca/image-imports/test"
    });

    expect(parsed.success).toBe(false);
    // The size guard has to run before the per-image regex, so the size issue is the one raised
    // and no "invalid base64 data url" issue is reported for the multi-megabyte strings.
    const reported = parsed.success ? "" : JSON.stringify(parsed.error.issues);

    expect(reported).toContain("Image extraction payload is too large.");
    expect(reported).not.toContain("invalid_string");
  });

  it("never lets an accepted payload exceed the API body limit", () => {
    expect(MAX_IMAGE_DATA_URL_CHARS).toBeLessThanOrEqual(MAX_IMAGE_EXTRACT_PAYLOAD_CHARS);
    expect(MAX_IMAGE_EXTRACT_PAYLOAD_CHARS).toBeLessThanOrEqual(8 * 1024 * 1024);
  });

  it("still accepts a normal image import", () => {
    expect(
      extractRecipeRequestSchema.safeParse({
        images: [{ dataUrl: "data:image/jpeg;base64,abc123", mimeType: "image/jpeg" }],
        sourceUrl: "https://linkdish.ca/image-imports/test"
      }).success
    ).toBe(true);
  });
});
