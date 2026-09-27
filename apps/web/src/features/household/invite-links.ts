import { safeGetItem, safeSetItem } from "../../platform/safe-storage";

import type { HouseholdInviteShare, HouseholdInviteSummary } from "@linkdish/api-contracts";

/** Links in invites always point at the production web app, wherever they were created. */
export const WEB_APP_ORIGIN = "https://app.linkdish.ca";

/** Mirrors householdInviteCodeSchema (8–120 characters after trimming). */
export const INVITE_CODE_MIN_LENGTH = 8;
export const INVITE_CODE_MAX_LENGTH = 120;

/** app.linkdish.ca/household?invite=CODE: opens this page with the code filled in. */
export const buildWebJoinLink = (inviteCode: string): string =>
  `${WEB_APP_ORIGIN}/household?invite=${encodeURIComponent(inviteCode)}`;

/** The link without the scheme, for display. */
export const formatLinkForDisplay = (link: string): string => link.replace(/^https?:\/\//u, "");

/**
 * Accepts what people actually paste: a bare code, a web join link (?invite=) or the emailed
 * invite link (?code=), with stray spaces or quotes around it.
 */
export const parseInviteInput = (input: string): string => {
  const trimmed = input.trim().replace(/^["'<]+|["'>]+$/gu, "");

  if (/^https?:\/\//iu.test(trimmed) || /^[\w.-]+\.[a-z]{2,}\//iu.test(trimmed)) {
    try {
      const url = new URL(/^https?:\/\//iu.test(trimmed) ? trimmed : `https://${trimmed}`);
      const code = url.searchParams.get("invite") ?? url.searchParams.get("code");

      if (code) {
        return code.trim();
      }
    } catch {
      // Not a URL after all; treat it as a code below.
    }
  }

  return trimmed;
};

/** A plain-language problem with an invite code, or null when it looks usable. */
export const getInviteCodeProblem = (input: string): string | null => {
  const code = parseInviteInput(input);

  if (!code) {
    return "Paste the invite code or link you were sent.";
  }

  if (code.length < INVITE_CODE_MIN_LENGTH) {
    return "That code looks too short. Invite codes are at least 8 characters, so check you copied all of it.";
  }

  if (code.length > INVITE_CODE_MAX_LENGTH || /\s/u.test(code)) {
    return "That doesn't look like an invite code. Try copying it again from the invite.";
  }

  return null;
};

/* ---------------------------------------------------------------------------------------------
 * The API only returns an invite's code once, when it is created. Owners keep a copy on this
 * device so a pending invite can be shared again later. Codes only work for the invited email.
 * ------------------------------------------------------------------------------------------- */

const INVITE_LINKS_STORAGE_KEY = "linkdish:web:household-invite-links:v1";

interface StoredInvite {
  code: string;
  email: string;
  expiresAt: string;
}

const readStoredInvites = (): Record<string, StoredInvite> => {
  try {
    const raw = safeGetItem(INVITE_LINKS_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    const entries = Object.entries(parsed as Record<string, unknown>).filter(
      (entry): entry is [string, StoredInvite] => {
        const value = entry[1] as Partial<StoredInvite> | null;
        return (
          typeof value?.code === "string" &&
          typeof value.email === "string" &&
          typeof value.expiresAt === "string"
        );
      }
    );

    return Object.fromEntries(entries);
  } catch {
    return {};
  }
};

const writeStoredInvites = (invites: Record<string, StoredInvite>): void => {
  safeSetItem(INVITE_LINKS_STORAGE_KEY, JSON.stringify(invites));
};

export const rememberInviteShare = (invite: HouseholdInviteShare): void => {
  writeStoredInvites({
    ...readStoredInvites(),
    [invite.id]: { code: invite.inviteCode, email: invite.email, expiresAt: invite.expiresAt }
  });
};

/**
 * Codes for the household's pending invites that this device created. Forgets invites that were
 * cancelled, accepted or have expired.
 */
export const getRememberedInviteCodes = (
  pendingInvites: ReadonlyArray<HouseholdInviteSummary>,
  now = Date.now()
): Record<string, string> => {
  const stored = readStoredInvites();
  const pendingIds = new Set(pendingInvites.map((invite) => invite.id));
  const kept: Record<string, StoredInvite> = {};
  const codes: Record<string, string> = {};

  for (const [id, invite] of Object.entries(stored)) {
    const expiresAt = Date.parse(invite.expiresAt);

    if (pendingIds.has(id) && (Number.isNaN(expiresAt) || expiresAt > now)) {
      kept[id] = invite;
      codes[id] = invite.code;
    }
  }

  if (Object.keys(kept).length !== Object.keys(stored).length) {
    writeStoredInvites(kept);
  }

  return codes;
};

export const formatInviteExpiry = (expiresAt: string, now = Date.now()): string => {
  const time = Date.parse(expiresAt);

  if (Number.isNaN(time)) {
    return "Expiry unknown";
  }

  if (time <= now) {
    return "Expired";
  }

  const days = Math.round((time - now) / 86_400_000);

  if (days >= 2) {
    return `Expires in ${days} days`;
  }

  const date = new Date(time);
  return `Expires ${date.toLocaleDateString(undefined, { day: "numeric", month: "short" })} at ${date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
};
