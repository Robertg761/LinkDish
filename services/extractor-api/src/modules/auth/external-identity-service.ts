import { randomBytes } from "node:crypto";

import {
  addStoreSetMembers,
  deleteStoreKeys,
  getStoreSetMembers,
  getStoreString,
  removeStoreSetMembers,
  runStoreEval,
  setStoreString
} from "../storage/upstash-store.js";

import {
  AuthError,
  getUserByEmail,
  getUserById,
  updateUserEmailById,
  upsertUserByEmail,
  type UserRecord
} from "./auth-service.js";

import type { AccountUser } from "../../../../../packages/api-contracts/src/index.js";

export type ExternalAuthProvider = "clerk";

export interface ExternalIdentity {
  email: string;
  emailVerified: boolean;
  provider: ExternalAuthProvider;
  subject: string;
}

const identityVersion = "v1";
const identityLockTtlSeconds = 10;
const identityLockRetryDelaysMs = [25, 75, 150, 300];
const releaseLockScript =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

export const externalIdentityKeys = {
  deletedIdentity: (provider: ExternalAuthProvider, subject: string) =>
    `linkdish:identity-deleted:${identityVersion}:${provider}:${subject}`,
  identity: (provider: ExternalAuthProvider, subject: string) =>
    `linkdish:identity:${identityVersion}:${provider}:${subject}`,
  lock: (provider: ExternalAuthProvider, subject: string) =>
    `linkdish:identity-lock:${identityVersion}:${provider}:${subject}`,
  userIdentities: (userId: string) => `linkdish:user-identities:${identityVersion}:${userId}`
};

const toAccountUser = (user: UserRecord): AccountUser => ({
  avatarEmoji: user.avatarEmoji ?? null,
  displayName: user.displayName ?? null,
  email: user.email,
  id: user.id
});

const identityMember = (identity: Pick<ExternalIdentity, "provider" | "subject">): string =>
  `${identity.provider}:${identity.subject}`;

const parseIdentityMember = (
  member: string
): Pick<ExternalIdentity, "provider" | "subject"> | null => {
  const separatorIndex = member.indexOf(":");

  if (separatorIndex <= 0) {
    return null;
  }

  const provider = member.slice(0, separatorIndex);
  const subject = member.slice(separatorIndex + 1);

  return provider === "clerk" && subject ? { provider, subject } : null;
};

const readMappedUser = async (
  provider: ExternalAuthProvider,
  subject: string
): Promise<AccountUser | null> => {
  const userId = await getStoreString(externalIdentityKeys.identity(provider, subject));

  if (!userId) {
    return null;
  }

  const user = await getUserById(userId);

  if (user) {
    return toAccountUser(user);
  }

  await setStoreString(externalIdentityKeys.deletedIdentity(provider, subject), userId);
  await deleteStoreKeys(externalIdentityKeys.identity(provider, subject));
  throw new AuthError(
    "This LinkDish account has been deleted. Contact support to recover it.",
    410
  );
};

const isIdentityTombstoned = async (
  provider: ExternalAuthProvider,
  subject: string
): Promise<boolean> =>
  Boolean(await getStoreString(externalIdentityKeys.deletedIdentity(provider, subject)));

const linkIdentityToUser = async (
  identity: ExternalIdentity,
  user: UserRecord
): Promise<AccountUser> => {
  await setStoreString(externalIdentityKeys.identity(identity.provider, identity.subject), user.id);
  await addStoreSetMembers(externalIdentityKeys.userIdentities(user.id), identityMember(identity));
  return toAccountUser(user);
};

const withIdentityLock = async <Value>(
  provider: ExternalAuthProvider,
  subject: string,
  operation: () => Promise<Value>
): Promise<Value> => {
  const lockValue = randomBytes(16).toString("base64url");
  const lockKey = externalIdentityKeys.lock(provider, subject);

  for (const retryDelayMs of [0, ...identityLockRetryDelaysMs]) {
    if (retryDelayMs > 0) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, retryDelayMs);
      });
    }

    const acquired = await setStoreString(lockKey, lockValue, {
      nx: true,
      ttlSeconds: identityLockTtlSeconds
    });

    if (!acquired) {
      continue;
    }

    try {
      return await operation();
    } finally {
      await runStoreEval(releaseLockScript, [lockKey], [lockValue]).catch((error) => {
        console.warn("Failed to release LinkDish external identity lock.", error);
      });
    }
  }

  throw new AuthError("This sign-in is still being linked. Please try again.", 409);
};

export const resolveExternalIdentity = async (identity: ExternalIdentity): Promise<AccountUser> => {
  const mappedUser = await readMappedUser(identity.provider, identity.subject);

  if (mappedUser) {
    return mappedUser;
  }

  return withIdentityLock(identity.provider, identity.subject, async () => {
    const lockedMappedUser = await readMappedUser(identity.provider, identity.subject);

    if (lockedMappedUser) {
      return lockedMappedUser;
    }

    if (await isIdentityTombstoned(identity.provider, identity.subject)) {
      throw new AuthError(
        "This LinkDish account has been deleted. Contact support to recover it.",
        410
      );
    }

    if (!identity.emailVerified) {
      throw new AuthError("A verified account email is required to sign in.", 403);
    }

    const existingUser = await getUserByEmail(identity.email);

    if (existingUser) {
      return linkIdentityToUser(identity, existingUser);
    }

    return linkIdentityToUser(identity, await upsertUserByEmail(identity.email));
  });
};

export const resolveMappedExternalIdentity = async (
  provider: ExternalAuthProvider,
  subject: string
): Promise<AccountUser | null> => {
  const mappedUser = await readMappedUser(provider, subject);

  if (mappedUser) {
    return mappedUser;
  }

  if (await isIdentityTombstoned(provider, subject)) {
    throw new AuthError(
      "This LinkDish account has been deleted. Contact support to recover it.",
      410
    );
  }

  return null;
};

export const tombstoneExternalIdentitiesForUser = async (userId: string): Promise<void> => {
  const members = await getStoreSetMembers(externalIdentityKeys.userIdentities(userId));
  const parsedMembers = members
    .map(parseIdentityMember)
    .filter((member): member is NonNullable<ReturnType<typeof parseIdentityMember>> =>
      Boolean(member)
    );

  await Promise.all(
    parsedMembers.map(async (identity) => {
      await setStoreString(
        externalIdentityKeys.deletedIdentity(identity.provider, identity.subject),
        userId
      );
      await deleteStoreKeys(externalIdentityKeys.identity(identity.provider, identity.subject));
    })
  );

  if (members.length > 0) {
    await removeStoreSetMembers(externalIdentityKeys.userIdentities(userId), ...members);
  }
};

export const tombstoneExternalIdentity = async (
  provider: ExternalAuthProvider,
  subject: string
): Promise<{ status: "not_mapped" | "tombstoned"; userId: string | null }> => {
  const identityKey = externalIdentityKeys.identity(provider, subject);
  const userId = await getStoreString(identityKey);
  const tombstoneUserId = userId ?? "unknown";

  await setStoreString(externalIdentityKeys.deletedIdentity(provider, subject), tombstoneUserId);
  await deleteStoreKeys(identityKey);

  if (userId) {
    await removeStoreSetMembers(
      externalIdentityKeys.userIdentities(userId),
      identityMember({ provider, subject })
    );
  }

  return {
    status: userId ? "tombstoned" : "not_mapped",
    userId
  };
};

export const syncMappedExternalIdentityEmail = async (
  provider: ExternalAuthProvider,
  subject: string,
  email: string
): Promise<{ status: "not_mapped" | "updated"; user: AccountUser | null }> => {
  const userId = await getStoreString(externalIdentityKeys.identity(provider, subject));

  if (!userId) {
    return {
      status: "not_mapped",
      user: null
    };
  }

  const user = await updateUserEmailById(userId, email);

  return {
    status: user ? "updated" : "not_mapped",
    user: user ? toAccountUser(user) : null
  };
};
