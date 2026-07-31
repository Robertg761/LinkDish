import { createClerkClient, verifyToken } from "@clerk/backend";

import { extractorApiEnv } from "../../config/env.js";

import {
  resolveExternalIdentity,
  resolveMappedExternalIdentity
} from "./external-identity-service.js";

import type { AccountUser } from "../../../../../packages/api-contracts/src/index.js";

interface VerifiedClerkSession {
  expiresAt: string;
  subject: string;
}

interface ClerkExternalIdentity {
  email: string;
  emailVerified: boolean;
  subject: string;
}

interface ClerkAuthVerifier {
  getExternalIdentity(subject: string): Promise<ClerkExternalIdentity>;
  verifySessionToken(token: string): Promise<VerifiedClerkSession>;
}

const splitEnvList = (value: string | undefined): string[] | undefined => {
  const values = value
    ?.split(/[,\s]+/u)
    .map((entry) => entry.trim())
    .filter(Boolean);

  return values && values.length > 0 ? values : undefined;
};

const normalizeEmail = (email: string): string => email.trim().toLowerCase();

const isAuthError = (error: unknown): error is Error & { statusCode: number } =>
  error instanceof Error && typeof (error as { statusCode?: unknown }).statusCode === "number";

export const isClerkAuthEnabled = (): boolean => extractorApiEnv.AUTH_MODE !== "legacy_email_code";

export const isJwtShapedToken = (token: string): boolean => token.split(".").length === 3;

const createDefaultClerkAuthVerifier = (): ClerkAuthVerifier => ({
  async getExternalIdentity(subject) {
    if (!extractorApiEnv.CLERK_SECRET_KEY) {
      throw new Error("CLERK_SECRET_KEY is required to fetch Clerk users.");
    }

    const clerkClient = createClerkClient({
      secretKey: extractorApiEnv.CLERK_SECRET_KEY
    });
    const user = await clerkClient.users.getUser(subject);
    const primaryEmail = user.emailAddresses.find(
      (emailAddress) => emailAddress.id === user.primaryEmailAddressId
    );

    return {
      email: primaryEmail ? normalizeEmail(primaryEmail.emailAddress) : "",
      emailVerified: primaryEmail?.verification?.status === "verified",
      subject
    };
  },
  async verifySessionToken(token) {
    const claims = await verifyToken(token, {
      audience: splitEnvList(extractorApiEnv.CLERK_JWT_AUDIENCE),
      authorizedParties: splitEnvList(extractorApiEnv.CLERK_AUTHORIZED_PARTIES),
      jwtKey: extractorApiEnv.CLERK_JWT_KEY,
      secretKey: extractorApiEnv.CLERK_SECRET_KEY
    });
    const subject = typeof claims.sub === "string" ? claims.sub : "";

    if (!subject) {
      throw new Error("Clerk token did not include a subject.");
    }

    return {
      expiresAt:
        typeof claims.exp === "number"
          ? new Date(claims.exp * 1000).toISOString()
          : new Date(Date.now() + 60_000).toISOString(),
      subject
    };
  }
});

let clerkAuthVerifier: ClerkAuthVerifier = createDefaultClerkAuthVerifier();

export const setClerkAuthVerifierForTesting = (verifier: ClerkAuthVerifier): void => {
  clerkAuthVerifier = verifier;
};

export const resetClerkAuthVerifierForTesting = (): void => {
  clerkAuthVerifier = createDefaultClerkAuthVerifier();
};

export const getAuthenticatedClerkUser = async (
  token: string
): Promise<{ expiresAt: string; sessionTokenHash: string; user: AccountUser } | null> => {
  if (!isClerkAuthEnabled() || !isJwtShapedToken(token)) {
    return null;
  }

  try {
    const verifiedSession = await clerkAuthVerifier.verifySessionToken(token);
    const mappedUser =
      (await resolveMappedExternalIdentity("clerk", verifiedSession.subject)) ??
      (await (async () => {
        const externalIdentity = await clerkAuthVerifier.getExternalIdentity(
          verifiedSession.subject
        );

        return resolveExternalIdentity({
          email: externalIdentity.email,
          emailVerified: externalIdentity.emailVerified,
          provider: "clerk",
          subject: verifiedSession.subject
        });
      })());

    return {
      expiresAt: verifiedSession.expiresAt,
      sessionTokenHash: `clerk:${verifiedSession.subject}`,
      user: mappedUser
    };
  } catch (error) {
    if (isAuthError(error)) {
      throw error;
    }

    return null;
  }
};
