import { randomBytes } from "node:crypto";

import { z } from "zod";

import { extractorApiEnv } from "../../config/env.js";
import { hashEmail, normalizeEmail } from "../auth/auth-service.js";
import { getHeader, getRequestAddress, hashServerSideIdentity } from "../request-identity.js";
import {
  addStoreSortedSetMember,
  checkStoreSlidingWindowRateLimit,
  getStoreSortedSetCount,
  getStoreSortedSetMembersWithScores,
  getStoreString,
  getStoreStrings,
  setStoreString
} from "../storage/upstash-store.js";

import type { RequestHeaders } from "../request-identity.js";

const waitlistVersion = "v1";
const rateLimitWindowMs = 60 * 60 * 1000;
const rateLimitTtlSeconds = Math.ceil(rateLimitWindowMs / 1000);
const rateLimitMax = 5;
const maxSourceLength = 120;

const signupSchema = z.object({
  email: z.string().trim().email().max(254),
  source: z.string().trim().max(maxSourceLength).optional()
});

interface IosWaitlistRecord {
  createdAt: string;
  email: string;
  emailHash: string;
  source?: string;
  userAgent?: string;
}

export interface IosWaitlistEntry {
  createdAt: string;
  email: string;
  emailHash: string;
  source: string | null;
  userAgent: string | null;
}

export interface IosWaitlistSnapshot {
  entries: IosWaitlistEntry[];
  hasMore: boolean;
  limit: number;
  total: number;
}

const waitlistRecordSchema = z.object({
  createdAt: z.string(),
  email: z.string().email(),
  emailHash: z.string(),
  source: z.string().optional(),
  userAgent: z.string().optional()
});

export class IosWaitlistError extends Error {
  public constructor(
    message: string,
    public readonly statusCode = 400
  ) {
    super(message);
    this.name = "IosWaitlistError";
  }
}

export const iosWaitlistKeys = {
  email: (emailHash: string) => `linkdish:ios-waitlist:${waitlistVersion}:email:${emailHash}`,
  index: () => `linkdish:ios-waitlist:${waitlistVersion}:emails`,
  rateLimit: (identityHash: string) =>
    `linkdish:ios-waitlist-rate-limit:${waitlistVersion}:${identityHash}`
};

const checkWaitlistRateLimit = async (headers: RequestHeaders): Promise<void> => {
  const identityHash = hashServerSideIdentity("ios-waitlist", getRequestAddress(headers));
  const key = iosWaitlistKeys.rateLimit(identityHash);
  const now = Date.now();
  const usage = await checkStoreSlidingWindowRateLimit({
    key,
    max: rateLimitMax,
    member: `${now}:${randomBytes(8).toString("base64url")}`,
    nowMs: now,
    ttlSeconds: rateLimitTtlSeconds,
    windowMs: rateLimitWindowMs
  });

  if (!usage.allowed) {
    throw new IosWaitlistError("Too many waitlist requests. Please try again later.", 429);
  }
};

const getWaitlistEmailSender = (): string | undefined =>
  extractorApiEnv.IOS_WAITLIST_EMAIL_FROM ?? extractorApiEnv.AUTH_EMAIL_FROM;

const sendIosWaitlistConfirmationEmail = async (email: string): Promise<void> => {
  const from = getWaitlistEmailSender();

  if (!extractorApiEnv.RESEND_API_KEY || !from) {
    if (extractorApiEnv.NODE_ENV !== "production") {
      console.info(`LinkDish iOS waitlist confirmation email for ${email}.`);
      return;
    }

    console.warn("LinkDish iOS waitlist confirmation email is not configured.");
    return;
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${extractorApiEnv.RESEND_API_KEY}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      from,
      html: [
        "<p>Thanks for joining the LinkDish iOS waitlist.</p>",
        "<p>We will send you a note when the iPhone version is ready to try.</p>",
        '<p>In the meantime, you can follow LinkDish updates at <a href="https://linkdish.ca/">linkdish.ca</a>.</p>'
      ].join(""),
      subject: "You are on the LinkDish iOS waitlist",
      text: [
        "Thanks for joining the LinkDish iOS waitlist.",
        "",
        "We will send you a note when the iPhone version is ready to try.",
        "",
        "In the meantime, you can follow LinkDish updates at https://linkdish.ca/."
      ].join("\n"),
      to: email
    })
  });

  if (!response.ok) {
    throw new IosWaitlistError("LinkDish could not send the iOS waitlist confirmation email.", 503);
  }
};

const parseWaitlistRecord = (value: string | null): IosWaitlistEntry | null => {
  if (!value) {
    return null;
  }

  let json: unknown;

  try {
    json = JSON.parse(value) as unknown;
  } catch {
    return null;
  }

  const parsed = waitlistRecordSchema.safeParse(json);

  if (!parsed.success) {
    return null;
  }

  return {
    createdAt: parsed.data.createdAt,
    email: parsed.data.email,
    emailHash: parsed.data.emailHash,
    source: parsed.data.source ?? null,
    userAgent: parsed.data.userAgent ?? null
  };
};

export const getIosWaitlistSnapshot = async (limit = 100): Promise<IosWaitlistSnapshot> => {
  const pageSize = Math.max(1, Math.min(500, Math.floor(limit)));
  const indexKey = iosWaitlistKeys.index();
  const total = await getStoreSortedSetCount(indexKey);
  const members = await getStoreSortedSetMembersWithScores(indexKey, 0, pageSize - 1, "desc");
  const records = await getStoreStrings(members.map(({ member }) => iosWaitlistKeys.email(member)));
  const entries = records
    .map(parseWaitlistRecord)
    .filter((entry): entry is IosWaitlistEntry => Boolean(entry))
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));

  return {
    entries,
    hasMore: total > members.length,
    limit: pageSize,
    total
  };
};

export const joinIosWaitlist = async (
  payload: unknown,
  headers: RequestHeaders
): Promise<{ alreadyJoined: boolean; email: string; status: "joined" }> => {
  const parsed = signupSchema.parse(payload);
  await checkWaitlistRateLimit(headers);

  const email = normalizeEmail(parsed.email);
  const emailHash = hashEmail(email);
  const key = iosWaitlistKeys.email(emailHash);
  const existing = await getStoreString(key);

  if (existing) {
    return {
      alreadyJoined: true,
      email,
      status: "joined"
    };
  }

  const userAgent = getHeader(headers, "user-agent")?.slice(0, 300);
  const record: IosWaitlistRecord = {
    createdAt: new Date().toISOString(),
    email,
    emailHash,
    ...(parsed.source ? { source: parsed.source } : {}),
    ...(userAgent ? { userAgent } : {})
  };

  const stored = await setStoreString(key, JSON.stringify(record), { nx: true });

  if (stored) {
    await addStoreSortedSetMember(iosWaitlistKeys.index(), Date.now(), emailHash);
    await sendIosWaitlistConfirmationEmail(email).catch((error) => {
      console.warn("Failed to send LinkDish iOS waitlist confirmation email.", error);
    });
  }

  return {
    alreadyJoined: !stored,
    email,
    status: "joined"
  };
};
