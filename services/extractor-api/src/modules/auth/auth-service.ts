import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import {
  accountProfileAvatarEmojiSchema,
  accountProfileDisplayNameSchema,
  type AccountUser,
  type UpdateAccountProfileRequest
} from "../../../../../packages/api-contracts/src/index.js";
import { extractorApiEnv } from "../../config/env.js";
import { getHeader, type RequestHeaders } from "../request-identity.js";
import {
  addStoreSetMembers,
  deleteStoreKeys,
  getStoreSetMembers,
  getStoreString,
  removeStoreSetMembers,
  runStoreEval,
  setStoreString
} from "../storage/upstash-store.js";

const userRecordSchema = z.object({
  id: z.string(),
  email: z.string().email(),
  emailHash: z.string(),
  displayName: z.string().min(1).max(40).nullable().optional(),
  avatarEmoji: z.string().min(1).max(16).nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  deletedAt: z.string().optional()
});

const authCodeRecordSchema = z.object({
  codeHash: z.string(),
  attempts: z.number().int().nonnegative(),
  createdAt: z.string()
});

const sessionRecordSchema = z.object({
  userId: z.string(),
  createdAt: z.string(),
  expiresAt: z.string()
});

export type UserRecord = z.infer<typeof userRecordSchema>;
type AuthCodeRecord = z.infer<typeof authCodeRecordSchema>;
type SessionRecord = z.infer<typeof sessionRecordSchema>;

export class AuthError extends Error {
  public constructor(
    message: string,
    public readonly statusCode = 400
  ) {
    super(message);
    this.name = "AuthError";
  }
}

const authVersion = "v1";
const authCodeLockTtlSeconds = 10;
const minimumCodeRequestSpacingMs = 60_000;
const releaseLockScript =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

const getAuthSecret = (): string =>
  extractorApiEnv.AUTH_SECRET ??
  extractorApiEnv.BILLING_QUOTA_IDENTITY_SECRET ??
  extractorApiEnv.REVENUECAT_SECRET_API_KEY ??
  "development";

const hmac = (purpose: string, value: string): string =>
  createHmac("sha256", getAuthSecret())
    .update(`linkdish-${purpose}-v1`)
    .update("\0")
    .update(value)
    .digest("hex");

export const hashEmail = (email: string): string =>
  hmac("email", normalizeEmail(email)).slice(0, 40);

const hashCode = (emailHash: string, code: string): string =>
  hmac("login-code", `${emailHash}:${code}`);

export const hashSessionToken = (sessionToken: string): string => hmac("session", sessionToken);

const createId = (prefix: string): string => `${prefix}_${randomBytes(16).toString("base64url")}`;

const createSessionToken = (): string => randomBytes(32).toString("base64url");

const createLoginCode = (): string => String(randomInt(100_000, 1_000_000));

const getAppReviewLoginCodeForEmail = (email: string): string | null => {
  const reviewCode = extractorApiEnv.APP_REVIEW_LOGIN_CODE;

  if (!reviewCode || !/^\d{6}$/.test(reviewCode)) {
    return null;
  }

  const reviewEmails = (extractorApiEnv.APP_REVIEW_LOGIN_EMAILS ?? "")
    .split(/[,\s]+/u)
    .map(normalizeEmail)
    .filter(Boolean);

  return reviewEmails.includes(normalizeEmail(email)) ? reviewCode : null;
};

export const authKeys = {
  authCode: (emailHash: string) => `linkdish:auth-code:${authVersion}:${emailHash}`,
  authCodeLock: (emailHash: string) => `linkdish:auth-code-lock:${authVersion}:${emailHash}`,
  emailLookup: (emailHash: string) => `linkdish:user-by-email:${authVersion}:${emailHash}`,
  session: (sessionTokenHash: string) => `linkdish:session:${authVersion}:${sessionTokenHash}`,
  user: (userId: string) => `linkdish:user:${authVersion}:${userId}`,
  userSessions: (userId: string) => `linkdish:user-sessions:${authVersion}:${userId}`
};

const withAuthCodeLock = async <Value>(
  emailHash: string,
  operation: () => Promise<Value>
): Promise<Value> => {
  const lockValue = randomBytes(16).toString("base64url");
  const lockKey = authKeys.authCodeLock(emailHash);
  const acquired = await setStoreString(lockKey, lockValue, {
    nx: true,
    ttlSeconds: authCodeLockTtlSeconds
  });

  if (!acquired) {
    throw new AuthError("That sign-in code is already being checked. Please try again.", 409);
  }

  try {
    return await operation();
  } finally {
    await runStoreEval(releaseLockScript, [lockKey], [lockValue]).catch((error) => {
      console.warn("Failed to release LinkDish auth code lock.", error);
    });
  }
};

const parseJson = <Value>(schema: z.ZodType<Value>, value: string | null): Value | null => {
  if (!value) {
    return null;
  }

  return schema.parse(JSON.parse(value) as unknown);
};

const toAccountUser = (user: UserRecord): AccountUser => ({
  avatarEmoji: user.avatarEmoji ?? null,
  displayName: user.displayName ?? null,
  email: user.email,
  id: user.id
});

export const getUserById = async (userId: string): Promise<UserRecord | null> => {
  const user = parseJson(userRecordSchema, await getStoreString(authKeys.user(userId)));
  return user && !user.deletedAt ? user : null;
};

export const getUserByEmail = async (email: string): Promise<UserRecord | null> => {
  const emailHash = hashEmail(email);
  const userId = await getStoreString(authKeys.emailLookup(emailHash));
  return userId ? getUserById(userId) : null;
};

export const upsertUserByEmail = async (email: string): Promise<UserRecord> => {
  const normalizedEmail = normalizeEmail(email);
  const emailHash = hashEmail(normalizedEmail);
  const existingUser = await getUserByEmail(normalizedEmail);
  const now = new Date().toISOString();

  if (existingUser) {
    const updatedUser = {
      ...existingUser,
      email: normalizedEmail,
      updatedAt: now
    };

    await setStoreString(authKeys.user(updatedUser.id), JSON.stringify(updatedUser));
    return updatedUser;
  }

  const user: UserRecord = {
    id: createId("user"),
    email: normalizedEmail,
    emailHash,
    createdAt: now,
    updatedAt: now
  };

  await setStoreString(authKeys.emailLookup(emailHash), user.id);
  await setStoreString(authKeys.user(user.id), JSON.stringify(user));
  return user;
};

export const updateUserEmailById = async (
  userId: string,
  email: string
): Promise<UserRecord | null> => {
  const user = await getUserById(userId);

  if (!user) {
    return null;
  }

  const normalizedEmail = normalizeEmail(email);
  const emailHash = hashEmail(normalizedEmail);

  if (emailHash === user.emailHash) {
    return user;
  }

  const existingUser = await getUserByEmail(normalizedEmail);

  if (existingUser && existingUser.id !== user.id) {
    throw new AuthError("That verified email already belongs to another LinkDish account.", 409);
  }

  const updatedUser = {
    ...user,
    email: normalizedEmail,
    emailHash,
    updatedAt: new Date().toISOString()
  };

  await deleteStoreKeys(authKeys.emailLookup(user.emailHash));
  await setStoreString(authKeys.emailLookup(emailHash), user.id);
  await setStoreString(authKeys.user(user.id), JSON.stringify(updatedUser));
  return updatedUser;
};

const normalizeProfileText = (
  value: string | null | undefined,
  options: { fieldName: string; maxLength: number }
): string | null => {
  if (value == null) {
    return null;
  }

  const trimmed = value.trim();

  if (!trimmed) {
    return null;
  }

  if (trimmed.length > options.maxLength) {
    throw new AuthError(`${options.fieldName} is too long.`, 400);
  }

  return trimmed;
};

const normalizeProfileEmoji = (value: string | null | undefined): string | null => {
  const normalized = normalizeProfileText(value, {
    fieldName: "Profile emoji",
    maxLength: 16
  });

  if (normalized === null) {
    return null;
  }

  const parsed = accountProfileAvatarEmojiSchema.safeParse(normalized);

  if (!parsed.success) {
    throw new AuthError("Profile avatar must be a single emoji.", 400);
  }

  return parsed.data;
};

const normalizeProfileDisplayName = (value: string | null | undefined): string | null => {
  const normalized = normalizeProfileText(value, {
    fieldName: "Display name",
    maxLength: 40
  });

  if (normalized === null) {
    return null;
  }

  const parsed = accountProfileDisplayNameSchema.safeParse(normalized);

  if (!parsed.success) {
    throw new AuthError(
      "Profile display name cannot include control or invisible characters.",
      400
    );
  }

  return parsed.data;
};

const applyProfileUpdate = (
  user: UserRecord,
  profile: UpdateAccountProfileRequest
): UserRecord => ({
  ...user,
  avatarEmoji:
    profile.avatarEmoji === undefined
      ? (user.avatarEmoji ?? null)
      : normalizeProfileEmoji(profile.avatarEmoji),
  displayName:
    profile.displayName === undefined
      ? (user.displayName ?? null)
      : normalizeProfileDisplayName(profile.displayName),
  updatedAt: new Date().toISOString()
});

export const updateUserProfileById = async (
  userId: string,
  profile: UpdateAccountProfileRequest
): Promise<AccountUser | null> => {
  const user = await getUserById(userId);

  if (!user) {
    return null;
  }

  const updatedUser = applyProfileUpdate(user, profile);

  await setStoreString(authKeys.user(updatedUser.id), JSON.stringify(updatedUser));
  return toAccountUser(updatedUser);
};

const sendLoginCodeEmail = async (email: string, code: string): Promise<void> => {
  if (!extractorApiEnv.RESEND_API_KEY || !extractorApiEnv.AUTH_EMAIL_FROM) {
    if (extractorApiEnv.NODE_ENV !== "production") {
      console.info(`LinkDish login code for ${email}: ${code}`);
      return;
    }

    throw new AuthError("Email login is not configured.", 503);
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${extractorApiEnv.RESEND_API_KEY}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      from: extractorApiEnv.AUTH_EMAIL_FROM,
      html: `<p>Your LinkDish sign-in code is <strong>${code}</strong>.</p><p>This code expires in 10 minutes.</p>`,
      subject: "Your LinkDish sign-in code",
      text: `Your LinkDish sign-in code is ${code}. This code expires in 10 minutes.`,
      to: email
    })
  });

  if (!response.ok) {
    throw new AuthError("LinkDish could not send a sign-in code right now.", 503);
  }
};

export const requestLoginCode = async (
  email: string
): Promise<{ email: string; expiresInSeconds: number }> => {
  const normalizedEmail = normalizeEmail(email);
  const emailHash = hashEmail(normalizedEmail);
  const appReviewLoginCode = getAppReviewLoginCodeForEmail(normalizedEmail);

  if (appReviewLoginCode) {
    await withAuthCodeLock(emailHash, async () => {
      const record: AuthCodeRecord = {
        attempts: 0,
        codeHash: hashCode(emailHash, appReviewLoginCode),
        createdAt: new Date().toISOString()
      };

      await setStoreString(authKeys.authCode(emailHash), JSON.stringify(record), {
        ttlSeconds: extractorApiEnv.AUTH_CODE_TTL_SECONDS
      });
    });

    return {
      email: normalizedEmail,
      expiresInSeconds: extractorApiEnv.AUTH_CODE_TTL_SECONDS
    };
  }

  const pendingCode = await withAuthCodeLock(emailHash, async () => {
    const existingRecord = parseJson(
      authCodeRecordSchema,
      await getStoreString(authKeys.authCode(emailHash))
    );

    if (
      existingRecord &&
      Date.now() - Date.parse(existingRecord.createdAt) < minimumCodeRequestSpacingMs
    ) {
      throw new AuthError("Please wait a moment before requesting another sign-in code.", 429);
    }

    const nextCode = createLoginCode();
    const codeHash = hashCode(emailHash, nextCode);
    const record: AuthCodeRecord = {
      attempts: 0,
      codeHash,
      createdAt: new Date().toISOString()
    };

    await setStoreString(authKeys.authCode(emailHash), JSON.stringify(record), {
      ttlSeconds: extractorApiEnv.AUTH_CODE_TTL_SECONDS
    });

    return {
      code: nextCode,
      codeHash
    };
  });

  try {
    await sendLoginCodeEmail(normalizedEmail, pendingCode.code);
  } catch (error) {
    try {
      await withAuthCodeLock(emailHash, async () => {
        const currentRecord = parseJson(
          authCodeRecordSchema,
          await getStoreString(authKeys.authCode(emailHash))
        );

        if (currentRecord?.codeHash === pendingCode.codeHash) {
          await deleteStoreKeys(authKeys.authCode(emailHash));
        }
      });
    } catch (rollbackError) {
      console.warn("Failed to roll back unsent LinkDish login code.", rollbackError);
    }

    throw error;
  }

  return {
    email: normalizedEmail,
    expiresInSeconds: extractorApiEnv.AUTH_CODE_TTL_SECONDS
  };
};

const constantTimeEquals = (left: string, right: string): boolean => {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
};

export const createSessionForUser = async (
  user: UserRecord
): Promise<{ expiresAt: string; sessionToken: string; user: AccountUser }> => {
  const sessionToken = createSessionToken();
  const sessionTokenHash = hashSessionToken(sessionToken);
  const now = Date.now();
  const expiresAt = new Date(now + extractorApiEnv.AUTH_SESSION_TTL_SECONDS * 1000).toISOString();
  const record: SessionRecord = {
    createdAt: new Date(now).toISOString(),
    expiresAt,
    userId: user.id
  };

  await setStoreString(authKeys.session(sessionTokenHash), JSON.stringify(record), {
    ttlSeconds: extractorApiEnv.AUTH_SESSION_TTL_SECONDS
  });
  await addStoreSetMembers(authKeys.userSessions(user.id), sessionTokenHash);

  return {
    expiresAt,
    sessionToken,
    user: toAccountUser(user)
  };
};

export const verifyLoginCode = async (
  email: string,
  code: string,
  profile?: UpdateAccountProfileRequest
): Promise<{ expiresAt: string; sessionToken: string; user: AccountUser }> => {
  const normalizedEmail = normalizeEmail(email);
  const emailHash = hashEmail(normalizedEmail);

  return withAuthCodeLock(emailHash, async () => {
    const key = authKeys.authCode(emailHash);
    const record = parseJson(authCodeRecordSchema, await getStoreString(key));

    const expiresAtMs = record
      ? Date.parse(record.createdAt) + extractorApiEnv.AUTH_CODE_TTL_SECONDS * 1000
      : 0;

    if (!record || expiresAtMs <= Date.now()) {
      if (record) {
        await deleteStoreKeys(key);
      }

      throw new AuthError("That sign-in code has expired. Request a new code.", 400);
    }

    if (record.attempts >= 5) {
      await deleteStoreKeys(key);
      throw new AuthError("Too many attempts. Request a new sign-in code.", 429);
    }

    if (!constantTimeEquals(record.codeHash, hashCode(emailHash, code))) {
      const remainingTtlSeconds = Math.max(1, Math.ceil((expiresAtMs - Date.now()) / 1000));

      await setStoreString(
        key,
        JSON.stringify({
          ...record,
          attempts: record.attempts + 1
        }),
        {
          ttlSeconds: remainingTtlSeconds
        }
      );
      throw new AuthError("That sign-in code is not correct.", 400);
    }

    await deleteStoreKeys(key);
    const user = await upsertUserByEmail(normalizedEmail);
    const profiledUser = profile ? applyProfileUpdate(user, profile) : user;

    if (profile) {
      await setStoreString(authKeys.user(profiledUser.id), JSON.stringify(profiledUser));
    }

    return createSessionForUser(profiledUser);
  });
};

export const getBearerToken = (headers: RequestHeaders): string | null => {
  const authorization = getHeader(headers, "authorization");

  if (!authorization?.startsWith("Bearer ")) {
    return null;
  }

  return authorization.slice("Bearer ".length).trim() || null;
};

const isJwtShapedToken = (token: string): boolean => token.split(".").length === 3;

export const getSessionByToken = async (
  sessionToken: string
): Promise<{ expiresAt: string; sessionTokenHash: string; user: AccountUser } | null> => {
  const sessionTokenHash = hashSessionToken(sessionToken);
  const session = parseJson(
    sessionRecordSchema,
    await getStoreString(authKeys.session(sessionTokenHash))
  );

  if (!session || Date.parse(session.expiresAt) <= Date.now()) {
    if (session) {
      await deleteStoreKeys(authKeys.session(sessionTokenHash));
    }

    return null;
  }

  const user = await getUserById(session.userId);

  if (!user) {
    await deleteStoreKeys(authKeys.session(sessionTokenHash));
    return null;
  }

  return {
    expiresAt: session.expiresAt,
    sessionTokenHash,
    user: toAccountUser(user)
  };
};

export const getAuthenticatedUser = async (
  headers: RequestHeaders
): Promise<{ expiresAt: string; sessionTokenHash: string; user: AccountUser } | null> => {
  const token = getBearerToken(headers);

  if (!token) {
    return null;
  }

  const session = await getSessionByToken(token);

  if (session || !isJwtShapedToken(token)) {
    return session;
  }

  const { getAuthenticatedClerkUser } = await import("./clerk-auth-service.js");
  return getAuthenticatedClerkUser(token);
};

export const logoutSession = async (sessionToken: string): Promise<void> => {
  const sessionTokenHash = hashSessionToken(sessionToken);
  const session = parseJson(
    sessionRecordSchema,
    await getStoreString(authKeys.session(sessionTokenHash))
  );

  if (session) {
    await removeStoreSetMembers(authKeys.userSessions(session.userId), sessionTokenHash);
  }

  await deleteStoreKeys(authKeys.session(sessionTokenHash));
};

export const deleteUserSessions = async (userId: string): Promise<void> => {
  const sessionHashes = await getStoreSetMembers(authKeys.userSessions(userId));
  await deleteStoreKeys(...sessionHashes.map(authKeys.session), authKeys.userSessions(userId));
};

export const markUserDeleted = async (userId: string): Promise<UserRecord | null> => {
  const user = await getUserById(userId);

  if (!user) {
    return null;
  }

  const deletedUser = {
    ...user,
    avatarEmoji: null,
    deletedAt: new Date().toISOString(),
    displayName: null,
    email: `deleted-${createHash("sha256").update(user.id).digest("hex").slice(0, 12)}@deleted.linkdish.local`,
    updatedAt: new Date().toISOString()
  };

  await deleteStoreKeys(authKeys.emailLookup(user.emailHash));
  await setStoreString(authKeys.user(user.id), JSON.stringify(deletedUser));
  await deleteUserSessions(user.id);
  return deletedUser;
};
