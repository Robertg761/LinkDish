/*
 * Which Upstash keys are account data (backed up every night) and which are disposable.
 *
 * Every `linkdish:<segment>:` key the API writes must have its segment listed in
 * `storeKeySegments`; store-key-families.test.ts scans the source and fails on a new one, so a
 * new kind of account data cannot quietly miss the backups. Versions are matched as `[^:]+` so a
 * version bump stays covered.
 */

export type BackupValueType = "set" | "string" | "zset";

export interface BackedUpKeyFamily {
  /* The key carries a TTL worth restoring (sessions, invites). */
  expires?: boolean;
  name: string;
  pattern: RegExp;
  type: BackupValueType;
}

export const backedUpKeyFamilies: readonly BackedUpKeyFamily[] = [
  // Accounts and sign-in (auth-service.ts, external-identity-service.ts)
  { name: "user", pattern: /^linkdish:user:[^:]+:.+$/u, type: "string" },
  { name: "user-by-email", pattern: /^linkdish:user-by-email:[^:]+:.+$/u, type: "string" },
  { expires: true, name: "session", pattern: /^linkdish:session:[^:]+:.+$/u, type: "string" },
  { name: "user-sessions", pattern: /^linkdish:user-sessions:[^:]+:.+$/u, type: "set" },
  { name: "identity", pattern: /^linkdish:identity:[^:]+:.+$/u, type: "string" },
  { name: "identity-deleted", pattern: /^linkdish:identity-deleted:[^:]+:.+$/u, type: "string" },
  { name: "user-identities", pattern: /^linkdish:user-identities:[^:]+:.+$/u, type: "set" },
  // Family households (household-service.ts)
  { name: "household", pattern: /^linkdish:household:[^:]+:.+$/u, type: "string" },
  { name: "household-by-user", pattern: /^linkdish:household-by-user:[^:]+:.+$/u, type: "string" },
  { expires: true, name: "invite", pattern: /^linkdish:invite:[^:]+:.+$/u, type: "string" },
  { name: "household-invites", pattern: /^linkdish:household-invites:[^:]+:.+$/u, type: "set" },
  { name: "household-recipe", pattern: /^linkdish:household-recipe:[^:]+:.+$/u, type: "string" },
  {
    name: "household-recipe-by-source",
    pattern: /^linkdish:household-recipe-by-source:[^:]+:.+$/u,
    type: "string"
  },
  { name: "household-recipes", pattern: /^linkdish:household-recipes:[^:]+:.+$/u, type: "set" },
  {
    name: "household-shopping-item",
    pattern: /^linkdish:household-shopping-item:[^:]+:.+$/u,
    type: "string"
  },
  {
    name: "household-shopping-items",
    pattern: /^linkdish:household-shopping-items:[^:]+:.+$/u,
    type: "set"
  },
  // Personal library sync (library-service.ts); its lock is disposable
  { name: "library-item", pattern: /^linkdish:library:[^:]+:item:.+$/u, type: "string" },
  { name: "library-live", pattern: /^linkdish:library:[^:]+:live:.+$/u, type: "set" },
  { name: "library-changes", pattern: /^linkdish:library:[^:]+:changes:.+$/u, type: "zset" },
  { name: "library-rev", pattern: /^linkdish:library:[^:]+:rev:.+$/u, type: "string" },
  // Admin settings and the billing grant audit trail
  { name: "admin-billing-grant", pattern: /^linkdish:admin:billing-grant:.+$/u, type: "string" },
  {
    name: "admin-llm-settings",
    pattern: /^linkdish:admin:[^:]+:[^:]+:llm-settings$/u,
    type: "string"
  },
  // iOS waitlist sign-ups
  {
    name: "ios-waitlist-email",
    pattern: /^linkdish:ios-waitlist:[^:]+:email:.+$/u,
    type: "string"
  },
  { name: "ios-waitlist-index", pattern: /^linkdish:ios-waitlist:[^:]+:emails$/u, type: "zset" },
  // Free plans' lifetime import counters (monthly counters and pending holds reset on their own)
  {
    name: "quota-lifetime",
    pattern: /^linkdish:quota:[^:]+:lifetime:(?!.*:pending$).+$/u,
    type: "string"
  }
];

/*
 * "backup": every key under the segment is account data. "ephemeral": locks, caches, rate
 * limits and one-time codes that rebuild themselves. "mixed": some of each, split by
 * `backedUpKeyFamilies`.
 */
export const storeKeySegments: Readonly<Record<string, "backup" | "ephemeral" | "mixed">> = {
  admin: "backup",
  "auth-code": "ephemeral",
  "auth-code-lock": "ephemeral",
  "auth-login-code-rate-limit": "ephemeral",
  entitlement: "ephemeral",
  "entitlement-invalidated": "ephemeral",
  "extract-cache": "ephemeral",
  household: "backup",
  "household-by-user": "backup",
  "household-invites": "backup",
  "household-lock": "ephemeral",
  "household-recipe": "backup",
  "household-recipe-by-source": "backup",
  "household-recipes": "backup",
  "household-shopping-item": "backup",
  "household-shopping-items": "backup",
  identity: "backup",
  "identity-deleted": "backup",
  "identity-lock": "ephemeral",
  invite: "backup",
  "ios-waitlist": "mixed",
  "ios-waitlist-rate-limit": "ephemeral",
  library: "mixed",
  quota: "mixed",
  "rate-limit": "ephemeral",
  session: "backup",
  user: "backup",
  "user-by-email": "backup",
  "user-identities": "backup",
  "user-sessions": "backup"
};

export const findBackedUpKeyFamily = (key: string): BackedUpKeyFamily | undefined =>
  backedUpKeyFamilies.find((family) => family.pattern.test(key));

/* "linkdish:user:v1:abc" -> "user"; used to count skipped keys without logging the keys. */
export const getStoreKeySegment = (key: string): string => key.split(":")[1] ?? "";
