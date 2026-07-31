import { createHmac, randomBytes } from "node:crypto";

import { z } from "zod";

import {
  type AccountUser,
  type DeleteShoppingItemsRequest,
  type DeleteShoppingItemsResponse,
  extractionProvenanceSchema,
  extractionStrategySchema,
  fetchModeSchema,
  type HouseholdDetails,
  type HouseholdInviteShare,
  type HouseholdInviteSummary,
  type HouseholdShoppingListResponse,
  MAX_HOUSEHOLD_SHOPPING_ITEMS,
  type SharedRecipe,
  type UpdateSharedRecipeRequest,
  type UpsertShoppingItemsRequest,
  type UpsertShoppingItemsResponse,
  type UpsertSharedRecipeRequest
} from "../../../../../packages/api-contracts/src/index.js";
import {
  recipeSchema,
  type ShoppingItem,
  shoppingItemSchema
} from "../../../../../packages/recipe-domain/src/index.js";
import { extractorApiEnv } from "../../config/env.js";
import {
  createSessionForUser,
  getUserByEmail,
  getUserById,
  hashEmail,
  markUserDeleted,
  normalizeEmail,
  updateUserProfileById,
  upsertUserByEmail
} from "../auth/auth-service.js";
import { tombstoneExternalIdentitiesForUser } from "../auth/external-identity-service.js";
import { hasActiveRevenueCatFamilyEntitlement } from "../billing/revenuecat-entitlements.js";
import {
  addStoreSetMembers,
  deleteStoreKeys,
  getStoreSetMembers,
  getStoreString,
  removeStoreSetMembers,
  runStoreEval,
  setStoreString
} from "../storage/upstash-store.js";

const cooldownSlotSchema = z.object({
  availableAt: z.string().datetime(),
  removedAt: z.string().datetime(),
  removedUserId: z.string()
});

const householdRecordSchema = z
  .object({
    id: z.string(),
    ownerUserId: z.string(),
    memberUserIds: z.array(z.string()),
    memberJoinedAt: z.record(z.string().datetime()).optional(),
    cooldownSlots: z.array(cooldownSlotSchema),
    createdAt: z.string(),
    updatedAt: z.string()
  })
  .transform((household) => ({
    ...household,
    memberJoinedAt: household.memberJoinedAt ?? {}
  }));

const inviteRecordSchema = z.object({
  id: z.string(),
  householdId: z.string(),
  email: z.string().email(),
  emailHash: z.string(),
  invitedByUserId: z.string(),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  acceptedAt: z.string().datetime().optional()
});

const sharedRecipeRecordSchema = z.object({
  id: z.string(),
  householdId: z.string(),
  ownerUserId: z.string(),
  ownerEmail: z.string().email(),
  sourceSavedRecipeId: z.string().optional(),
  recipe: recipeSchema,
  notes: z.string().optional(),
  fetchMode: fetchModeSchema,
  provenance: z.array(extractionProvenanceSchema),
  strategy: extractionStrategySchema,
  warnings: z.array(z.string()),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});

const shoppingItemRecordSchema = shoppingItemSchema.extend({
  householdId: z.string()
});

type CooldownSlot = z.infer<typeof cooldownSlotSchema>;
type HouseholdRecord = z.infer<typeof householdRecordSchema>;
type InviteRecord = z.infer<typeof inviteRecordSchema>;
type SharedRecipeRecord = z.infer<typeof sharedRecipeRecordSchema>;
type ShoppingItemRecord = z.infer<typeof shoppingItemRecordSchema>;
type SharedRecipeOwnerProfile = Pick<AccountUser, "avatarEmoji" | "displayName"> | null | undefined;

export class HouseholdError extends Error {
  public constructor(
    message: string,
    public readonly statusCode = 400
  ) {
    super(message);
    this.name = "HouseholdError";
  }
}

const householdVersion = "v1";
const lockTtlSeconds = 30;
const lockRetryDelaysMs = [25, 75, 150, 300];
const releaseLockScript =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

const householdKeys = {
  household: (householdId: string) => `linkdish:household:${householdVersion}:${householdId}`,
  householdByUser: (userId: string) => `linkdish:household-by-user:${householdVersion}:${userId}`,
  invite: (inviteCodeHash: string) => `linkdish:invite:${householdVersion}:${inviteCodeHash}`,
  householdInvites: (householdId: string) =>
    `linkdish:household-invites:${householdVersion}:${householdId}`,
  lock: (householdId: string) => `linkdish:household-lock:${householdVersion}:${householdId}`,
  sharedRecipe: (sharedRecipeId: string) =>
    `linkdish:household-recipe:${householdVersion}:${sharedRecipeId}`,
  sharedRecipeBySource: (householdId: string, ownerUserId: string, sourceSavedRecipeId: string) =>
    `linkdish:household-recipe-by-source:${householdVersion}:${householdId}:${ownerUserId}:${sourceSavedRecipeId}`,
  sharedRecipes: (householdId: string) =>
    `linkdish:household-recipes:${householdVersion}:${householdId}`,
  shoppingItem: (shoppingItemId: string) =>
    `linkdish:household-shopping-item:${householdVersion}:${shoppingItemId}`,
  shoppingItems: (householdId: string) =>
    `linkdish:household-shopping-items:${householdVersion}:${householdId}`
};

const getHouseholdSecret = (): string =>
  extractorApiEnv.AUTH_SECRET ??
  extractorApiEnv.BILLING_QUOTA_IDENTITY_SECRET ??
  extractorApiEnv.REVENUECAT_SECRET_API_KEY ??
  "development";

const hashInviteCode = (inviteCode: string): string =>
  createHmac("sha256", getHouseholdSecret())
    .update("linkdish-household-invite-v1")
    .update("\0")
    .update(inviteCode.trim())
    .digest("hex");

const createId = (prefix: string): string => `${prefix}_${randomBytes(16).toString("base64url")}`;

const createInviteCode = (): string => randomBytes(18).toString("base64url");

const DEFAULT_PUBLIC_SITE_URL = "https://linkdish.ca";

const getPublicSiteUrl = (): string =>
  (extractorApiEnv.LINKDISH_PUBLIC_SITE_URL ?? DEFAULT_PUBLIC_SITE_URL).replace(/\/+$/u, "");

const buildHouseholdInviteUrl = (inviteCode: string): string =>
  `${getPublicSiteUrl()}/invite/?code=${encodeURIComponent(inviteCode)}`;

const parseJson = <Schema extends z.ZodTypeAny>(
  schema: Schema,
  value: string | null
): z.output<Schema> | null => {
  if (!value) {
    return null;
  }

  return schema.parse(JSON.parse(value) as unknown) as z.output<Schema>;
};

const getHouseholdById = async (householdId: string): Promise<HouseholdRecord | null> =>
  parseJson(householdRecordSchema, await getStoreString(householdKeys.household(householdId)));

export const getHouseholdIdForUser = async (userId: string): Promise<string | null> =>
  getStoreString(householdKeys.householdByUser(userId));

const getSharedRecipeRecordById = async (
  sharedRecipeId: string
): Promise<SharedRecipeRecord | null> =>
  parseJson(
    sharedRecipeRecordSchema,
    await getStoreString(householdKeys.sharedRecipe(sharedRecipeId))
  );

const getShoppingItemRecordById = async (
  shoppingItemId: string
): Promise<ShoppingItemRecord | null> =>
  parseJson(
    shoppingItemRecordSchema,
    await getStoreString(householdKeys.shoppingItem(shoppingItemId))
  );

const toSharedRecipe = (
  record: SharedRecipeRecord,
  ownerProfile?: SharedRecipeOwnerProfile
): SharedRecipe => ({
  createdAt: record.createdAt,
  fetchMode: record.fetchMode,
  householdId: record.householdId,
  id: record.id,
  notes: record.notes,
  ownerAvatarEmoji: ownerProfile?.avatarEmoji ?? null,
  ownerDisplayName: ownerProfile?.displayName ?? null,
  ownerEmail: record.ownerEmail,
  ownerUserId: record.ownerUserId,
  provenance: record.provenance,
  recipe: record.recipe,
  sourceSavedRecipeId: record.sourceSavedRecipeId,
  strategy: record.strategy,
  updatedAt: record.updatedAt,
  warnings: record.warnings
});

const toShoppingItem = (record: ShoppingItemRecord): ShoppingItem =>
  shoppingItemSchema.parse(record);

const saveHousehold = async (household: HouseholdRecord): Promise<void> => {
  await setStoreString(
    householdKeys.household(household.id),
    JSON.stringify({
      ...household,
      updatedAt: new Date().toISOString()
    })
  );
};

const withHouseholdLock = async <Value>(
  householdId: string,
  operation: () => Promise<Value>
): Promise<Value> => {
  const lockValue = randomBytes(16).toString("base64url");
  const acquireLock = async (): Promise<boolean> =>
    setStoreString(householdKeys.lock(householdId), lockValue, {
      nx: true,
      ttlSeconds: lockTtlSeconds
    });

  for (const retryDelayMs of [0, ...lockRetryDelaysMs]) {
    if (retryDelayMs > 0) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, retryDelayMs);
      });
    }

    if (!(await acquireLock())) {
      continue;
    }

    try {
      return await operation();
    } finally {
      await runStoreEval(releaseLockScript, [householdKeys.lock(householdId)], [lockValue]).catch(
        (error) => {
          console.warn("Failed to release LinkDish household lock.", error);
        }
      );
    }
  }

  throw new HouseholdError("This household is being updated. Please try again.", 409);
};

const activeCooldownSlots = (household: HouseholdRecord): CooldownSlot[] =>
  household.cooldownSlots.filter((slot) => Date.parse(slot.availableAt) > Date.now());

const pruneExpiredCooldowns = (household: HouseholdRecord): HouseholdRecord => ({
  ...household,
  cooldownSlots: activeCooldownSlots(household)
});

const getInviteByHash = async (inviteCodeHash: string): Promise<InviteRecord | null> =>
  parseJson(inviteRecordSchema, await getStoreString(householdKeys.invite(inviteCodeHash)));

const getActiveInvites = async (householdId: string): Promise<InviteRecord[]> => {
  const inviteHashes = await getStoreSetMembers(householdKeys.householdInvites(householdId));
  const invites = await Promise.all(inviteHashes.map(getInviteByHash));
  const activeInvites = invites.filter((invite): invite is InviteRecord =>
    Boolean(invite && !invite.acceptedAt && Date.parse(invite.expiresAt) > Date.now())
  );
  const inactiveHashes = inviteHashes.filter(
    (inviteHash) => !activeInvites.some((invite) => invite.id === inviteHash)
  );

  await removeStoreSetMembers(householdKeys.householdInvites(householdId), ...inactiveHashes);

  return activeInvites;
};

const sendInviteEmail = async (email: string, inviteCode: string): Promise<void> => {
  if (!extractorApiEnv.RESEND_API_KEY || !extractorApiEnv.AUTH_EMAIL_FROM) {
    if (extractorApiEnv.NODE_ENV !== "production") {
      console.info(`LinkDish household invite for ${email}: ${inviteCode}`);
      return;
    }

    throw new HouseholdError("Household invite email is not configured.", 503);
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${extractorApiEnv.RESEND_API_KEY}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      from: extractorApiEnv.AUTH_EMAIL_FROM,
      html: `<p>You have been invited to join a LinkDish Family household.</p><p>Open LinkDish and enter this invite code:</p><p><strong>${inviteCode}</strong></p>`,
      subject: "Join a LinkDish Family household",
      text: `You have been invited to join a LinkDish Family household. Open LinkDish and enter this invite code: ${inviteCode}`,
      to: email
    })
  });

  if (!response.ok) {
    throw new HouseholdError("LinkDish could not send the household invite right now.", 503);
  }
};

const toInviteSummary = (invite: InviteRecord): HouseholdInviteSummary => ({
  email: invite.email,
  expiresAt: invite.expiresAt,
  id: invite.id
});

const buildHouseholdDetails = async (
  household: HouseholdRecord,
  currentUserId: string,
  options?: {
    ownerFamilyEntitlementActive?: boolean;
  }
): Promise<HouseholdDetails> => {
  const prunedHousehold = pruneExpiredCooldowns(household);
  const users = await Promise.all(prunedHousehold.memberUserIds.map(getUserById));
  const invites = await getActiveInvites(prunedHousehold.id);
  const members = users
    .filter((user): user is NonNullable<typeof user> => Boolean(user))
    .map((user) => ({
      avatarEmoji: user.avatarEmoji ?? null,
      displayName: user.displayName ?? null,
      email: user.email,
      joinedAt: prunedHousehold.memberJoinedAt[user.id] ?? prunedHousehold.createdAt,
      role: user.id === prunedHousehold.ownerUserId ? ("owner" as const) : ("member" as const),
      userId: user.id
    }));
  const ownerFamilyEntitlementActive =
    options?.ownerFamilyEntitlementActive ??
    (await hasActiveRevenueCatFamilyEntitlement(prunedHousehold.ownerUserId).catch(() => false));

  return {
    activeMemberCount: members.length,
    cooldownSlotCount: prunedHousehold.cooldownSlots.length,
    id: prunedHousehold.id,
    invites: invites.map(toInviteSummary),
    memberLimit: extractorApiEnv.HOUSEHOLD_MEMBER_LIMIT,
    members,
    ownerFamilyEntitlementActive,
    ownerUserId: prunedHousehold.ownerUserId,
    role: currentUserId === prunedHousehold.ownerUserId ? "owner" : "member"
  };
};

const normalizeNotes = (notes: string | null | undefined): string | undefined => {
  const trimmed = notes?.trim();
  return trimmed ? trimmed : undefined;
};

const getActiveHouseholdForSharedRecipes = async (
  user: AccountUser
): Promise<{ household: HouseholdRecord; householdId: string }> => {
  const activeHouseholdQuota = await getActiveHouseholdQuotaForUser(user.id);

  if (!activeHouseholdQuota) {
    throw new HouseholdError("An active LinkDish Family household is required.", 403);
  }

  const household = await getHouseholdById(activeHouseholdQuota.householdId);

  if (!household || !household.memberUserIds.includes(user.id)) {
    throw new HouseholdError("This account does not belong to an active household.", 404);
  }

  return {
    household,
    householdId: activeHouseholdQuota.householdId
  };
};

const listSharedRecipeRecordsForHousehold = async (
  householdId: string
): Promise<SharedRecipeRecord[]> => {
  const sharedRecipeIds = await getStoreSetMembers(householdKeys.sharedRecipes(householdId));
  const records = await Promise.all(sharedRecipeIds.map(getSharedRecipeRecordById));

  return records
    .filter((record): record is SharedRecipeRecord => Boolean(record))
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
};

const deleteSharedRecipeRecord = async (record: SharedRecipeRecord): Promise<void> => {
  await deleteStoreKeys(
    householdKeys.sharedRecipe(record.id),
    ...(record.sourceSavedRecipeId
      ? [
          householdKeys.sharedRecipeBySource(
            record.householdId,
            record.ownerUserId,
            record.sourceSavedRecipeId
          )
        ]
      : [])
  );
  await removeStoreSetMembers(householdKeys.sharedRecipes(record.householdId), record.id);
};

const deleteSharedRecipesForUserInHousehold = async (
  householdId: string,
  userId: string
): Promise<void> => {
  const records = await listSharedRecipeRecordsForHousehold(householdId);
  await Promise.all(
    records
      .filter((record) => record.ownerUserId === userId)
      .map((record) => deleteSharedRecipeRecord(record))
  );
};

const deleteSharedRecipesForHousehold = async (householdId: string): Promise<void> => {
  const records = await listSharedRecipeRecordsForHousehold(householdId);
  await Promise.all(records.map((record) => deleteSharedRecipeRecord(record)));
  await deleteStoreKeys(householdKeys.sharedRecipes(householdId));
};

const listShoppingItemRecordsForHousehold = async (
  householdId: string
): Promise<ShoppingItemRecord[]> => {
  const shoppingItemIds = await getStoreSetMembers(householdKeys.shoppingItems(householdId));
  const records = await Promise.all(shoppingItemIds.map(getShoppingItemRecordById));

  return records
    .filter(
      (record): record is ShoppingItemRecord => Boolean(record && record.householdId === householdId)
    )
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
};

const deleteShoppingItemRecord = async (record: ShoppingItemRecord): Promise<void> => {
  await deleteStoreKeys(householdKeys.shoppingItem(record.id));
  await removeStoreSetMembers(householdKeys.shoppingItems(record.householdId), record.id);
};

const deleteShoppingItemsForUserInHousehold = async (
  householdId: string,
  userId: string
): Promise<void> => {
  const records = await listShoppingItemRecordsForHousehold(householdId);
  await Promise.all(
    records
      .filter((record) => record.addedBy === userId)
      .map((record) => deleteShoppingItemRecord(record))
  );
};

const deleteShoppingItemsForHousehold = async (householdId: string): Promise<void> => {
  const records = await listShoppingItemRecordsForHousehold(householdId);
  await Promise.all(records.map((record) => deleteShoppingItemRecord(record)));
  await deleteStoreKeys(householdKeys.shoppingItems(householdId));
};

const isIncomingShoppingItemNewer = (
  existingRecord: ShoppingItemRecord | null,
  incomingUpdatedAt: string
): boolean => {
  if (!existingRecord) {
    return true;
  }

  return Date.parse(incomingUpdatedAt) >= Date.parse(existingRecord.updatedAt);
};

export const getHouseholdShoppingListForUser = async (
  user: AccountUser
): Promise<HouseholdShoppingListResponse> => {
  const { householdId } = await getActiveHouseholdForSharedRecipes(user);

  return {
    items: (await listShoppingItemRecordsForHousehold(householdId)).map(toShoppingItem)
  };
};

export const upsertShoppingItemsForUser = async (
  user: AccountUser,
  input: UpsertShoppingItemsRequest
): Promise<UpsertShoppingItemsResponse> => {
  const { householdId } = await getActiveHouseholdForSharedRecipes(user);

  return withHouseholdLock(householdId, async () => {
    const household = await getHouseholdById(householdId);

    if (!household || !household.memberUserIds.includes(user.id)) {
      throw new HouseholdError("This account does not belong to an active household.", 404);
    }

    const existingRecords = await listShoppingItemRecordsForHousehold(householdId);
    const existingRecordIds = new Set(existingRecords.map((record) => record.id));
    const incomingNewItemIds = new Set(
      input.items
        .map((item) => item.id)
        .filter((itemId) => !existingRecordIds.has(itemId))
    );

    if (existingRecords.length + incomingNewItemIds.size > MAX_HOUSEHOLD_SHOPPING_ITEMS) {
      throw new HouseholdError(
        `Household shopping lists can hold up to ${MAX_HOUSEHOLD_SHOPPING_ITEMS} items.`,
        409
      );
    }

    const ignored: UpsertShoppingItemsResponse["ignored"] = [];

    for (const item of input.items) {
      const existingRecord = await getShoppingItemRecordById(item.id);

      if (existingRecord && existingRecord.householdId !== householdId) {
        throw new HouseholdError("This shopping item belongs to another household.", 403);
      }

      if (existingRecord && !isIncomingShoppingItemNewer(existingRecord, item.updatedAt)) {
        ignored.push({
          existingUpdatedAt: existingRecord.updatedAt,
          id: item.id,
          reason: "older_update"
        });
        continue;
      }

      const record: ShoppingItemRecord = {
        ...item,
        addedBy: existingRecord?.addedBy ?? user.id,
        householdId
      };

      await setStoreString(householdKeys.shoppingItem(record.id), JSON.stringify(record));
      await addStoreSetMembers(householdKeys.shoppingItems(householdId), record.id);
    }

    return {
      ignored,
      items: (await listShoppingItemRecordsForHousehold(householdId)).map(toShoppingItem)
    };
  });
};

export const deleteShoppingItemsForUser = async (
  user: AccountUser,
  input: DeleteShoppingItemsRequest
): Promise<DeleteShoppingItemsResponse> => {
  const { householdId } = await getActiveHouseholdForSharedRecipes(user);

  return withHouseholdLock(householdId, async () => {
    const household = await getHouseholdById(householdId);

    if (!household || !household.memberUserIds.includes(user.id)) {
      throw new HouseholdError("This account does not belong to an active household.", 404);
    }

    const deletedItemIds: string[] = [];
    const ignored: DeleteShoppingItemsResponse["ignored"] = [];

    for (const item of input.items) {
      const existingRecord = await getShoppingItemRecordById(item.id);

      if (!existingRecord) {
        deletedItemIds.push(item.id);
        continue;
      }

      if (existingRecord.householdId !== householdId) {
        throw new HouseholdError("This shopping item belongs to another household.", 403);
      }

      if (!isIncomingShoppingItemNewer(existingRecord, item.updatedAt)) {
        ignored.push({
          existingUpdatedAt: existingRecord.updatedAt,
          id: item.id,
          reason: "older_update"
        });
        continue;
      }

      await deleteShoppingItemRecord(existingRecord);
      deletedItemIds.push(item.id);
    }

    return {
      deletedItemIds,
      ignored,
      status: "deleted"
    };
  });
};

export const getSharedRecipesForUser = async (
  user: AccountUser
): Promise<{ recipes: SharedRecipe[] }> => {
  const { household, householdId } = await getActiveHouseholdForSharedRecipes(user);
  const memberUserIds = new Set(household.memberUserIds);
  const records = await listSharedRecipeRecordsForHousehold(householdId);
  const ownerProfiles = new Map(
    await Promise.all(
      [...new Set(records.map((record) => record.ownerUserId))].map(
        async (ownerUserId) => [ownerUserId, await getUserById(ownerUserId)] as const
      )
    )
  );

  return {
    recipes: records
      .filter((record) => memberUserIds.has(record.ownerUserId))
      .map((record) => toSharedRecipe(record, ownerProfiles.get(record.ownerUserId)))
  };
};

export const upsertSharedRecipeForUser = async (
  user: AccountUser,
  input: UpsertSharedRecipeRequest
): Promise<SharedRecipe> => {
  const { householdId } = await getActiveHouseholdForSharedRecipes(user);

  return withHouseholdLock(householdId, async () => {
    const household = await getHouseholdById(householdId);

    if (!household || !household.memberUserIds.includes(user.id)) {
      throw new HouseholdError("This account does not belong to an active household.", 404);
    }

    const existingSharedRecipeId = input.sourceSavedRecipeId
      ? await getStoreString(
          householdKeys.sharedRecipeBySource(householdId, user.id, input.sourceSavedRecipeId)
        )
      : null;
    const existingRecord = existingSharedRecipeId
      ? await getSharedRecipeRecordById(existingSharedRecipeId)
      : null;
    const now = new Date().toISOString();
    const record: SharedRecipeRecord = {
      createdAt: existingRecord?.createdAt ?? now,
      fetchMode: input.fetchMode,
      householdId,
      id: existingRecord?.id ?? createId("shared_recipe"),
      notes: normalizeNotes(input.notes),
      ownerEmail: user.email,
      ownerUserId: user.id,
      provenance: input.provenance,
      recipe: input.recipe,
      sourceSavedRecipeId: input.sourceSavedRecipeId,
      strategy: input.strategy,
      updatedAt: now,
      warnings: input.warnings
    };

    await setStoreString(householdKeys.sharedRecipe(record.id), JSON.stringify(record));
    await addStoreSetMembers(householdKeys.sharedRecipes(householdId), record.id);

    if (input.sourceSavedRecipeId) {
      await setStoreString(
        householdKeys.sharedRecipeBySource(householdId, user.id, input.sourceSavedRecipeId),
        record.id
      );
    }

    return toSharedRecipe(record, user);
  });
};

export const updateSharedRecipeForUser = async (
  user: AccountUser,
  sharedRecipeId: string,
  input: UpdateSharedRecipeRequest
): Promise<SharedRecipe> => {
  const { householdId } = await getActiveHouseholdForSharedRecipes(user);

  return withHouseholdLock(householdId, async () => {
    const existingRecord = await getSharedRecipeRecordById(sharedRecipeId);

    if (!existingRecord || existingRecord.householdId !== householdId) {
      throw new HouseholdError("This shared recipe is no longer available.", 404);
    }

    if (existingRecord.ownerUserId !== user.id) {
      throw new HouseholdError("Only the recipe owner can edit this shared recipe.", 403);
    }

    const updatedRecord: SharedRecipeRecord = {
      ...existingRecord,
      fetchMode: input.fetchMode ?? existingRecord.fetchMode,
      notes: input.notes === undefined ? existingRecord.notes : normalizeNotes(input.notes),
      ownerEmail: user.email,
      provenance: input.provenance ?? existingRecord.provenance,
      recipe: input.recipe ?? existingRecord.recipe,
      strategy: input.strategy ?? existingRecord.strategy,
      updatedAt: new Date().toISOString(),
      warnings: input.warnings ?? existingRecord.warnings
    };

    await setStoreString(
      householdKeys.sharedRecipe(updatedRecord.id),
      JSON.stringify(updatedRecord)
    );

    return toSharedRecipe(updatedRecord, user);
  });
};

export const deleteSharedRecipeForUser = async (
  user: AccountUser,
  sharedRecipeId: string
): Promise<{ status: "deleted" }> => {
  const { householdId } = await getActiveHouseholdForSharedRecipes(user);

  return withHouseholdLock(householdId, async () => {
    const existingRecord = await getSharedRecipeRecordById(sharedRecipeId);

    if (!existingRecord || existingRecord.householdId !== householdId) {
      return {
        status: "deleted"
      };
    }

    if (existingRecord.ownerUserId !== user.id) {
      throw new HouseholdError("Only the recipe owner can remove this shared recipe.", 403);
    }

    await deleteSharedRecipeRecord(existingRecord);

    return {
      status: "deleted"
    };
  });
};

export const getHouseholdSummaryForUser = async (
  userId: string
): Promise<{ household: HouseholdDetails | null }> => {
  const householdId = await getHouseholdIdForUser(userId);

  if (!householdId) {
    return { household: null };
  }

  const household = await getHouseholdById(householdId);

  if (!household || !household.memberUserIds.includes(userId)) {
    await deleteStoreKeys(householdKeys.householdByUser(userId));
    return { household: null };
  }

  return {
    household: await buildHouseholdDetails(household, userId)
  };
};

export const createHouseholdForOwner = async (owner: AccountUser): Promise<HouseholdDetails> => {
  if (!(await hasActiveRevenueCatFamilyEntitlement(owner.id))) {
    throw new HouseholdError("LinkDish Family is required to create a household.", 403);
  }

  return withHouseholdLock(`user:${owner.id}`, async () => {
    const existingHouseholdId = await getHouseholdIdForUser(owner.id);

    if (existingHouseholdId) {
      const existingHousehold = await getHouseholdById(existingHouseholdId);

      if (existingHousehold) {
        return buildHouseholdDetails(existingHousehold, owner.id, {
          ownerFamilyEntitlementActive: true
        });
      }

      await deleteStoreKeys(householdKeys.householdByUser(owner.id));
    }

    const now = new Date().toISOString();
    const household: HouseholdRecord = {
      cooldownSlots: [],
      createdAt: now,
      id: createId("household"),
      memberJoinedAt: {
        [owner.id]: now
      },
      memberUserIds: [owner.id],
      ownerUserId: owner.id,
      updatedAt: now
    };

    await setStoreString(householdKeys.household(household.id), JSON.stringify(household));
    await setStoreString(householdKeys.householdByUser(owner.id), household.id);

    return buildHouseholdDetails(household, owner.id, {
      ownerFamilyEntitlementActive: true
    });
  });
};

const rollbackPendingInviteCreation = async (
  householdId: string,
  inviteCodeHash: string
): Promise<void> => {
  await withHouseholdLock(householdId, async () => {
    const invite = await getInviteByHash(inviteCodeHash);

    if (!invite?.acceptedAt) {
      await deleteStoreKeys(householdKeys.invite(inviteCodeHash));
      await removeStoreSetMembers(householdKeys.householdInvites(householdId), inviteCodeHash);
    }
  });
};

export const createHouseholdInvite = async (
  owner: AccountUser,
  email: string
): Promise<{ household: HouseholdDetails; invite: HouseholdInviteShare }> => {
  const householdId = await getHouseholdIdForUser(owner.id);

  if (!householdId) {
    throw new HouseholdError("Create a household before inviting members.", 404);
  }

  const preflightHousehold = await getHouseholdById(householdId);

  if (!preflightHousehold || preflightHousehold.ownerUserId !== owner.id) {
    throw new HouseholdError("Only the household owner can invite members.", 403);
  }

  if (!(await hasActiveRevenueCatFamilyEntitlement(owner.id))) {
    throw new HouseholdError("LinkDish Family is required to invite household members.", 403);
  }

  const pendingInvite = await withHouseholdLock(householdId, async () => {
    const household = await getHouseholdById(householdId);

    if (!household || household.ownerUserId !== owner.id) {
      throw new HouseholdError("Only the household owner can invite members.", 403);
    }

    const prunedHousehold = pruneExpiredCooldowns(household);

    const activeInvites = await getActiveInvites(prunedHousehold.id);

    if (
      prunedHousehold.memberUserIds.length +
        activeCooldownSlots(prunedHousehold).length +
        activeInvites.length >=
      extractorApiEnv.HOUSEHOLD_MEMBER_LIMIT
    ) {
      throw new HouseholdError("This household has no available member slots right now.", 409);
    }

    const normalizedEmail = normalizeEmail(email);
    const emailHash = hashEmail(normalizedEmail);
    const ownerUser = await getUserById(owner.id);
    const invitedUser = await getUserByEmail(normalizedEmail);

    if (ownerUser?.email === normalizedEmail) {
      throw new HouseholdError("You are already the household owner.", 400);
    }

    if (invitedUser && prunedHousehold.memberUserIds.includes(invitedUser.id)) {
      throw new HouseholdError("That account is already in this household.", 409);
    }

    if (invitedUser && (await getHouseholdIdForUser(invitedUser.id))) {
      throw new HouseholdError("That account already belongs to a household.", 409);
    }

    if (activeInvites.some((invite) => invite.emailHash === emailHash)) {
      throw new HouseholdError("An active invite already exists for that email.", 409);
    }

    const inviteCode = createInviteCode();
    const inviteCodeHash = hashInviteCode(inviteCode);
    const now = new Date();
    const invite: InviteRecord = {
      createdAt: now.toISOString(),
      email: normalizedEmail,
      emailHash,
      expiresAt: new Date(
        now.getTime() + extractorApiEnv.HOUSEHOLD_INVITE_TTL_SECONDS * 1000
      ).toISOString(),
      householdId,
      id: inviteCodeHash,
      invitedByUserId: owner.id
    };

    await setStoreString(householdKeys.invite(inviteCodeHash), JSON.stringify(invite), {
      ttlSeconds: extractorApiEnv.HOUSEHOLD_INVITE_TTL_SECONDS
    });
    await addStoreSetMembers(householdKeys.householdInvites(householdId), inviteCodeHash);
    await saveHousehold(prunedHousehold);

    return {
      household: await buildHouseholdDetails(prunedHousehold, owner.id, {
        ownerFamilyEntitlementActive: true
      }),
      invite,
      inviteCode
    };
  });

  try {
    await sendInviteEmail(pendingInvite.invite.email, pendingInvite.inviteCode);
  } catch (error) {
    try {
      await rollbackPendingInviteCreation(householdId, pendingInvite.invite.id);
    } catch (rollbackError) {
      console.warn("Failed to roll back unsent LinkDish household invite.", rollbackError);
    }

    throw error;
  }

  return {
    household: pendingInvite.household,
    invite: {
      ...toInviteSummary(pendingInvite.invite),
      inviteCode: pendingInvite.inviteCode,
      inviteUrl: buildHouseholdInviteUrl(pendingInvite.inviteCode)
    }
  };
};

export const acceptHouseholdInvite = async (
  user: AccountUser,
  inviteCode: string
): Promise<HouseholdDetails> => {
  const inviteCodeHash = hashInviteCode(inviteCode);
  const invite = await getInviteByHash(inviteCodeHash);

  if (!invite || invite.acceptedAt || Date.parse(invite.expiresAt) <= Date.now()) {
    throw new HouseholdError("That household invite is no longer valid.", 404);
  }

  if (hashEmail(user.email) !== invite.emailHash) {
    throw new HouseholdError("This invite was sent to a different email address.", 403);
  }

  const preflightHousehold = await getHouseholdById(invite.householdId);

  if (!preflightHousehold) {
    throw new HouseholdError("That household no longer exists.", 404);
  }

  if (!(await hasActiveRevenueCatFamilyEntitlement(preflightHousehold.ownerUserId))) {
    throw new HouseholdError("This household does not have an active LinkDish Family plan.", 403);
  }

  return withHouseholdLock(`user:${user.id}`, async () => {
    if (await getHouseholdIdForUser(user.id)) {
      throw new HouseholdError("This account already belongs to a household.", 409);
    }

    return withHouseholdLock(invite.householdId, async () => {
      const household = await getHouseholdById(invite.householdId);

      if (!household) {
        throw new HouseholdError("That household no longer exists.", 404);
      }

      const now = new Date().toISOString();
      const prunedHousehold = pruneExpiredCooldowns(household);

      if (prunedHousehold.memberUserIds.length >= extractorApiEnv.HOUSEHOLD_MEMBER_LIMIT) {
        throw new HouseholdError("This household is full.", 409);
      }

      const updatedHousehold = {
        ...prunedHousehold,
        memberJoinedAt: {
          ...prunedHousehold.memberJoinedAt,
          [user.id]: now
        },
        memberUserIds: [...prunedHousehold.memberUserIds, user.id]
      };

      await saveHousehold(updatedHousehold);
      await setStoreString(householdKeys.householdByUser(user.id), updatedHousehold.id);
      await setStoreString(
        householdKeys.invite(inviteCodeHash),
        JSON.stringify({
          ...invite,
          acceptedAt: now
        }),
        {
          ttlSeconds: extractorApiEnv.HOUSEHOLD_INVITE_TTL_SECONDS
        }
      );
      await removeStoreSetMembers(
        householdKeys.householdInvites(updatedHousehold.id),
        inviteCodeHash
      );

      return buildHouseholdDetails(updatedHousehold, user.id, {
        ownerFamilyEntitlementActive: true
      });
    });
  });
};

export const cancelHouseholdInvite = async (
  owner: AccountUser,
  inviteId: string
): Promise<{ household: HouseholdDetails }> => {
  const householdId = await getHouseholdIdForUser(owner.id);

  if (!householdId) {
    throw new HouseholdError("This account does not own a household.", 404);
  }

  const preflightHousehold = await getHouseholdById(householdId);

  if (!preflightHousehold || preflightHousehold.ownerUserId !== owner.id) {
    throw new HouseholdError("Only the household owner can cancel invites.", 403);
  }

  return withHouseholdLock(householdId, async () => {
    const household = await getHouseholdById(householdId);

    if (!household || household.ownerUserId !== owner.id) {
      throw new HouseholdError("Only the household owner can cancel invites.", 403);
    }

    const prunedHousehold = pruneExpiredCooldowns(household);
    const invite = await getInviteByHash(inviteId);

    if (invite?.householdId === householdId && !invite.acceptedAt) {
      await deleteStoreKeys(householdKeys.invite(inviteId));
      await removeStoreSetMembers(householdKeys.householdInvites(householdId), inviteId);
    }

    await saveHousehold(prunedHousehold);

    return {
      household: await buildHouseholdDetails(prunedHousehold, owner.id)
    };
  });
};

export const removeHouseholdMember = async (
  owner: AccountUser,
  memberUserId: string
): Promise<HouseholdDetails> => {
  const householdId = await getHouseholdIdForUser(owner.id);

  if (!householdId) {
    throw new HouseholdError("This account does not own a household.", 404);
  }

  const preflightHousehold = await getHouseholdById(householdId);

  if (!preflightHousehold || preflightHousehold.ownerUserId !== owner.id) {
    throw new HouseholdError("Only the household owner can remove members.", 403);
  }

  if (!(await hasActiveRevenueCatFamilyEntitlement(owner.id))) {
    throw new HouseholdError("LinkDish Family is required to manage household members.", 403);
  }

  return withHouseholdLock(householdId, async () => {
    const household = await getHouseholdById(householdId);

    if (!household || household.ownerUserId !== owner.id) {
      throw new HouseholdError("Only the household owner can remove members.", 403);
    }

    if (memberUserId === owner.id) {
      throw new HouseholdError("Owner transfer is not supported yet.", 400);
    }

    if (!household.memberUserIds.includes(memberUserId)) {
      throw new HouseholdError("That user is not in this household.", 404);
    }

    const now = new Date();
    const availableAt = new Date(
      now.getTime() + extractorApiEnv.HOUSEHOLD_REPLACEMENT_COOLDOWN_DAYS * 86_400_000
    ).toISOString();
    const memberJoinedAt = { ...household.memberJoinedAt };
    delete memberJoinedAt[memberUserId];
    const updatedHousehold = pruneExpiredCooldowns({
      ...household,
      cooldownSlots: [
        ...household.cooldownSlots,
        {
          availableAt,
          removedAt: now.toISOString(),
          removedUserId: memberUserId
        }
      ],
      memberJoinedAt,
      memberUserIds: household.memberUserIds.filter((userId) => userId !== memberUserId)
    });

    await saveHousehold(updatedHousehold);
    await deleteStoreKeys(householdKeys.householdByUser(memberUserId));
    await deleteSharedRecipesForUserInHousehold(householdId, memberUserId);
    await deleteShoppingItemsForUserInHousehold(householdId, memberUserId);

    return buildHouseholdDetails(updatedHousehold, owner.id, {
      ownerFamilyEntitlementActive: true
    });
  });
};

export const leaveHousehold = async (user: AccountUser): Promise<{ household: null }> => {
  const householdId = await getHouseholdIdForUser(user.id);

  if (!householdId) {
    return { household: null };
  }

  await withHouseholdLock(householdId, async () => {
    const household = await getHouseholdById(householdId);

    if (!household) {
      return;
    }

    if (household.ownerUserId === user.id) {
      throw new HouseholdError("The owner cannot leave without deleting the household.", 400);
    }

    const now = new Date();
    const availableAt = new Date(
      now.getTime() + extractorApiEnv.HOUSEHOLD_REPLACEMENT_COOLDOWN_DAYS * 86_400_000
    ).toISOString();
    const memberJoinedAt = { ...household.memberJoinedAt };
    delete memberJoinedAt[user.id];

    await saveHousehold(
      pruneExpiredCooldowns({
        ...household,
        cooldownSlots: [
          ...household.cooldownSlots,
          {
            availableAt,
            removedAt: now.toISOString(),
            removedUserId: user.id
          }
        ],
        memberJoinedAt,
        memberUserIds: household.memberUserIds.filter((userId) => userId !== user.id)
      })
    );
    await deleteStoreKeys(householdKeys.householdByUser(user.id));
    await deleteSharedRecipesForUserInHousehold(householdId, user.id);
    await deleteShoppingItemsForUserInHousehold(householdId, user.id);
  });

  return { household: null };
};

export const dissolveHousehold = async (ownerUserId: string): Promise<void> => {
  const householdId = await getHouseholdIdForUser(ownerUserId);

  if (!householdId) {
    return;
  }

  await withHouseholdLock(householdId, async () => {
    const household = await getHouseholdById(householdId);

    if (!household) {
      return;
    }

    const inviteHashes = await getStoreSetMembers(householdKeys.householdInvites(householdId));
    await deleteSharedRecipesForHousehold(householdId);
    await deleteShoppingItemsForHousehold(householdId);
    await deleteStoreKeys(
      householdKeys.household(householdId),
      householdKeys.householdInvites(householdId),
      ...household.memberUserIds.map(householdKeys.householdByUser),
      ...inviteHashes.map(householdKeys.invite)
    );
  });
};

export const deleteAccountAndHouseholdAccess = async (
  user: AccountUser,
  confirmEmail: string
): Promise<void> => {
  await withHouseholdLock(`user:${user.id}`, async () => {
    if (normalizeEmail(confirmEmail) !== normalizeEmail(user.email)) {
      throw new HouseholdError(
        "Confirm the account email address before deleting this account.",
        400
      );
    }

    const householdId = await getHouseholdIdForUser(user.id);
    const household = householdId ? await getHouseholdById(householdId) : null;

    if (household?.ownerUserId === user.id) {
      await dissolveHousehold(user.id);
    } else if (household) {
      await leaveHousehold(user);
    }

    await markUserDeleted(user.id);
    await tombstoneExternalIdentitiesForUser(user.id);
  });
};

const debugHouseholdProfiles = [
  {
    avatarEmoji: "🍳",
    displayName: "Robin Test",
    email: "debug-owner@linkdish.test"
  },
  {
    avatarEmoji: "🥘",
    displayName: "Alex Kitchen",
    email: "debug-alex@linkdish.test"
  },
  {
    avatarEmoji: "🥗",
    displayName: "Sam Mealprep",
    email: "debug-sam@linkdish.test"
  },
  {
    avatarEmoji: "🍋",
    displayName: "Jamie Citrus",
    email: "debug-jamie@linkdish.test"
  },
  {
    avatarEmoji: "🌶️",
    displayName: "Priya Tandoor",
    email: "debug-priya@linkdish.test"
  },
  {
    avatarEmoji: "🍪",
    displayName: "Morgan Snacks",
    email: "debug-morgan@linkdish.test"
  }
] as const;

const slugifyDebugValue = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "");

const buildDebugSharedRecipeInput = (
  owner: AccountUser,
  title: string,
  ingredients: string[],
  steps: string[],
  notes: string
): UpsertSharedRecipeRequest => {
  const slug = slugifyDebugValue(title);

  return {
    fetchMode: "http",
    notes,
    provenance: ["visible-text"],
    recipe: {
      confidence: {
        fieldProvenance: {
          cookTimeMinutes: "visible-text",
          ingredients: "visible-text",
          nutrition: null,
          prepTimeMinutes: "visible-text",
          servings: "visible-text",
          steps: "visible-text",
          title: "visible-text"
        },
        missingFields: [],
        notes: ["Debug household fixture."],
        score: 0.92,
        summary: "Seeded debug recipe for household testing."
      },
      cookTimeMinutes: 25,
      ingredients: ingredients.map((text) => ({ text })),
      nutrition: null,
      prepTimeMinutes: 15,
      servings: "4 servings",
      sourceType: "article",
      sourceUrl: `https://debug.linkdish.test/recipes/${slug}`,
      steps: steps.map((text, index) => ({
        index: index + 1,
        text
      })),
      title
    },
    sourceSavedRecipeId: `debug-${owner.id}-${slug}`.slice(0, 180),
    strategy: "article-pattern",
    warnings: []
  };
};

const ensureDebugSimulatorAllowed = (): void => {
  if (extractorApiEnv.NODE_ENV === "production") {
    throw new HouseholdError("The household simulator is not available in production.", 404);
  }
};

const grantDebugFamilyPlan = (ownerUserId: string): void => {
  const existingUserIds = new Set(
    (extractorApiEnv.LINKDISH_TEST_PREMIUM_USER_IDS ?? "")
      .split(/[,\s]+/u)
      .map((userId) => userId.trim())
      .filter(Boolean)
  );

  existingUserIds.add(ownerUserId);
  extractorApiEnv.LINKDISH_TEST_PREMIUM_USER_IDS = [...existingUserIds].join(",");
  extractorApiEnv.LINKDISH_TEST_PREMIUM_PLAN_ID = "family";
};

const deleteHouseholdForDebugReset = async (householdId: string): Promise<void> => {
  const household = await getHouseholdById(householdId);

  if (!household) {
    return;
  }

  const inviteHashes = await getStoreSetMembers(householdKeys.householdInvites(householdId));
  await deleteSharedRecipesForHousehold(householdId);
  await deleteShoppingItemsForHousehold(householdId);
  await deleteStoreKeys(
    householdKeys.household(householdId),
    householdKeys.householdInvites(householdId),
    ...household.memberUserIds.map(householdKeys.householdByUser),
    ...inviteHashes.map(householdKeys.invite)
  );
};

const resetDebugHouseholdsForUsers = async (userIds: string[]): Promise<void> => {
  const householdIds = new Set(
    (await Promise.all(userIds.map(getHouseholdIdForUser))).filter(
      (householdId): householdId is string => Boolean(householdId)
    )
  );

  for (const householdId of householdIds) {
    await deleteHouseholdForDebugReset(householdId);
  }

  await deleteStoreKeys(...userIds.map(householdKeys.householdByUser));
};

export const createDebugFullHouseholdSimulation = async (): Promise<{
  expiresAt: string;
  household: HouseholdDetails;
  recipes: SharedRecipe[];
  sessionToken: string;
  user: AccountUser;
}> => {
  ensureDebugSimulatorAllowed();

  const users = await Promise.all(
    debugHouseholdProfiles.map(async (profile) => {
      const createdUser = await upsertUserByEmail(profile.email);
      await updateUserProfileById(createdUser.id, {
        avatarEmoji: profile.avatarEmoji,
        displayName: profile.displayName
      });
      const refreshedUser = await getUserById(createdUser.id);

      if (!refreshedUser) {
        throw new HouseholdError("Failed to create a debug household user.", 500);
      }

      return refreshedUser;
    })
  );
  const [owner, alex, sam, jamie] = users;

  if (!owner || !alex || !sam || !jamie) {
    throw new HouseholdError("Failed to create the full debug household roster.", 500);
  }

  await resetDebugHouseholdsForUsers(users.map((user) => user.id));
  grantDebugFamilyPlan(owner.id);

  const now = Date.now();
  const householdCreatedAt = new Date(now - 14 * 86_400_000).toISOString();
  const household: HouseholdRecord = {
    cooldownSlots: [],
    createdAt: householdCreatedAt,
    id: createId("household_debug"),
    memberJoinedAt: Object.fromEntries(
      users.map((user, index) => [
        user.id,
        new Date(now - (14 - index * 2) * 86_400_000).toISOString()
      ])
    ),
    memberUserIds: users.map((user) => user.id),
    ownerUserId: owner.id,
    updatedAt: new Date(now).toISOString()
  };

  await setStoreString(householdKeys.household(household.id), JSON.stringify(household));
  await Promise.all(
    users.map((user) => setStoreString(householdKeys.householdByUser(user.id), household.id))
  );

  const recipeInputs = [
    buildDebugSharedRecipeInput(
      owner,
      "Weeknight Lemon Orzo",
      ["1 cup orzo", "2 lemons", "1 bunch parsley", "1/2 cup grated parmesan"],
      ["Boil the orzo until tender.", "Fold in lemon zest, juice, herbs, and parmesan."],
      "Owner favorite. Good warm or packed cold for lunch."
    ),
    buildDebugSharedRecipeInput(
      alex,
      "Big Batch Black Bean Chili",
      ["2 cans black beans", "1 sweet potato", "2 tbsp chili powder", "1 can crushed tomatoes"],
      ["Simmer the vegetables with spices.", "Add beans and tomatoes, then cook until thick."],
      "Alex added this for testing shared recipe ownership."
    ),
    buildDebugSharedRecipeInput(
      sam,
      "Sheet Pan Sesame Tofu",
      ["14 oz tofu", "2 cups broccoli", "2 tbsp soy sauce", "1 tbsp sesame oil"],
      ["Press and cube the tofu.", "Roast tofu and broccoli until crisp at the edges."],
      "Sam's easy weeknight dinner."
    ),
    buildDebugSharedRecipeInput(
      jamie,
      "Citrus Breakfast Muffins",
      ["2 cups flour", "1 orange", "1/2 cup yogurt", "1/3 cup olive oil"],
      ["Whisk the wet ingredients.", "Bake until the tops spring back."],
      "Jamie marked these as freezer friendly."
    )
  ];
  const recipeOwners = [owner, alex, sam, jamie];

  await Promise.all(
    recipeInputs.map((input, index) => {
      const recipeOwner = recipeOwners[index];

      if (!recipeOwner) {
        throw new HouseholdError("Failed to assign a debug recipe owner.", 500);
      }

      return upsertSharedRecipeForUser(recipeOwner, input);
    })
  );

  const session = await createSessionForUser(owner);
  const householdDetails = await buildHouseholdDetails(household, owner.id, {
    ownerFamilyEntitlementActive: true
  });
  const { recipes } = await getSharedRecipesForUser(session.user);

  return {
    expiresAt: session.expiresAt,
    household: householdDetails,
    recipes,
    sessionToken: session.sessionToken,
    user: session.user
  };
};

export const getActiveHouseholdQuotaForUser = async (
  userId: string
): Promise<{
  householdId: string;
  ownerUserId: string;
  role: "member" | "owner";
} | null> => {
  const householdId = await getHouseholdIdForUser(userId);

  if (!householdId) {
    return null;
  }

  const household = await getHouseholdById(householdId);

  if (!household || !household.memberUserIds.includes(userId)) {
    return null;
  }

  if (!(await hasActiveRevenueCatFamilyEntitlement(household.ownerUserId))) {
    return null;
  }

  return {
    householdId,
    ownerUserId: household.ownerUserId,
    role: userId === household.ownerUserId ? "owner" : "member"
  };
};
