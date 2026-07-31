import { MaterialCommunityIcons } from "@expo/vector-icons";
import { ExtractorApiError, createExtractorApiClient } from "@linkdish/api-client";
import { AppButton, AppSurface, AppText } from "@linkdish/ui";
import { router, useLocalSearchParams } from "expo-router";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  Easing,
  Modal,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  TextInput,
  View
} from "react-native";

import { AppDialog } from "../src/components/AppDialog";
import { mobileEnv } from "../src/config/env";
import { useAccount } from "../src/features/account/AccountContext";
import { useBilling } from "../src/features/billing/BillingContext";
import { useOptionalUpgradeMoment } from "../src/features/billing/UpgradeMomentContext";
import { useSavedRecipes } from "../src/features/saved-recipes/SavedRecipesContext";
import { pressedOpacity } from "../src/theme/interactions";
import { appColors } from "../src/theme/tokens";

import type {
  HouseholdDetails,
  HouseholdInviteShare,
  HouseholdMember
} from "@linkdish/api-contracts";

const getErrorMessage = (error: unknown): string => {
  if (error instanceof ExtractorApiError && typeof error.details === "object" && error.details) {
    const message = (error.details as { message?: unknown }).message;

    if (typeof message === "string" && message.trim()) {
      return message;
    }
  }

  return error instanceof Error ? error.message : "Household action failed.";
};

const formatInviteExpiry = (expiresAt: string): string => {
  const expiresTime = Date.parse(expiresAt);

  if (Number.isNaN(expiresTime)) {
    return "Expiration unavailable";
  }

  const expiresDate = new Date(expiresAt);
  const dateLabel = expiresDate.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short"
  });
  const timeLabel = expiresDate.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit"
  });

  return `Expires ${dateLabel} at ${timeLabel}`;
};

const getMemberName = (member: HouseholdMember): string =>
  member.displayName?.trim() || member.email;

const destructiveIconColor = "#dc2626";

const RemoveMemberButton = ({
  disabled,
  isRemoving,
  memberName,
  onPress
}: {
  disabled: boolean;
  isRemoving: boolean;
  memberName: string;
  onPress: () => void;
}) => {
  const pressProgress = useRef(new Animated.Value(1)).current;
  const opacity = pressProgress.interpolate({
    inputRange: [0.96, 1],
    outputRange: [0.72, 1]
  });
  const animatePress = (toValue: number, duration: number) => {
    Animated.timing(pressProgress, {
      duration,
      easing: Easing.out(Easing.cubic),
      toValue,
      useNativeDriver: true
    }).start();
  };

  return (
    <Animated.View
      style={[
        styles.removeButtonFrame,
        {
          opacity: disabled ? 0.48 : opacity,
          transform: [{ scale: pressProgress }]
        }
      ]}
    >
      <Pressable
        accessibilityLabel={`Remove ${memberName}`}
        accessibilityRole="button"
        disabled={disabled}
        onPress={onPress}
        onPressIn={() => animatePress(0.96, 90)}
        onPressOut={() => animatePress(1, 150)}
        style={styles.removeButton}
      >
        <MaterialCommunityIcons
          color={destructiveIconColor}
          name={isRemoving ? "trash-can" : "trash-can-outline"}
          size={22}
        />
      </Pressable>
    </Animated.View>
  );
};

export default function HouseholdScreen() {
  const params = useLocalSearchParams<{ invite?: string | string[] }>();
  const inviteParam = Array.isArray(params.invite) ? params.invite[0] : params.invite;
  const { getAuthHeaders, hasLoadedAccount, isSignedIn, refreshAccount, user } = useAccount();
  const { purchaseStatus, restorePurchases, revenueCatConfigured, tier } = useBilling();
  const { showUpgradeMoment } = useOptionalUpgradeMoment();
  const { refreshSharedRecipes } = useSavedRecipes();
  const [error, setError] = useState<string | null>(null);
  const [household, setHousehold] = useState<HouseholdDetails | null>(null);
  const [inviteCode, setInviteCode] = useState(inviteParam ?? "");
  const [inviteEmail, setInviteEmail] = useState("");
  const [isInviteModalVisible, setIsInviteModalVisible] = useState(false);
  const [lastCreatedInvite, setLastCreatedInvite] = useState<HouseholdInviteShare | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [memberPendingRemoval, setMemberPendingRemoval] = useState<HouseholdMember | null>(null);
  const [invitePendingCancellation, setInvitePendingCancellation] = useState<{
    email: string;
    id: string;
  } | null>(null);
  const [removingMemberId, setRemovingMemberId] = useState<string | null>(null);
  const hasFamilyPlan = tier === "family";
  const isRestoringPurchases = purchaseStatus === "restoring";
  const client = useMemo(
    () =>
      createExtractorApiClient({
        baseUrl: mobileEnv.apiBaseUrl,
        getHeaders: getAuthHeaders
      }),
    [getAuthHeaders]
  );
  const groupedHouseholdMembers = useMemo(
    () => ({
      members: household?.members.filter((member) => member.role !== "owner") ?? [],
      owners: household?.members.filter((member) => member.role === "owner") ?? []
    }),
    [household]
  );

  const refreshHousehold = useCallback(async () => {
    if (!isSignedIn) {
      setHousehold(null);
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const response = await client.getHousehold();
      setHousehold(response.household);
    } catch (loadError) {
      setError(getErrorMessage(loadError));
    } finally {
      setIsLoading(false);
    }
  }, [client, isSignedIn]);

  useEffect(() => {
    void refreshHousehold();
  }, [refreshHousehold]);

  useEffect(() => {
    if (inviteParam) {
      setInviteCode(inviteParam);
    }
  }, [inviteParam]);

  const runAction = async (
    action: () => Promise<HouseholdDetails | null>,
    options: { refreshAccountAfterward?: boolean } = {}
  ) => {
    setIsLoading(true);
    setError(null);

    try {
      setHousehold(await action());
      await refreshSharedRecipes();

      if (options.refreshAccountAfterward) {
        await refreshAccount();
      }
    } catch (actionError) {
      setError(getErrorMessage(actionError));
    } finally {
      setIsLoading(false);
    }
  };

  const createHousehold = () =>
    runAction(async () => {
      const response = await client.createHousehold();
      return response.household;
    });

  const sendInvite = () =>
    runAction(async () => {
      const response = await client.createHouseholdInvite({ email: inviteEmail.trim() });
      setLastCreatedInvite(response.invite);
      setInviteEmail("");
      setIsInviteModalVisible(false);
      return response.household;
    });

  const cancelInvite = (inviteId: string, email: string) => {
    setInvitePendingCancellation({ email, id: inviteId });
  };

  const shareInvite = (invite: HouseholdInviteShare) => {
    void Share.share({
      message: `I saved you a seat in our LinkDish household. Join our shared cookbook and shopping list here:\n${invite.inviteUrl}\n\nInvite code: ${invite.inviteCode}`,
      title: "Join my LinkDish household"
    }).catch(() => undefined);
  };

  const acceptInvite = () =>
    runAction(
      async () => {
        const response = await client.acceptHouseholdInvite({ inviteCode });
        setInviteCode("");
        return response.household;
      },
      {
        refreshAccountAfterward: true
      }
    );

  const closeRemoveMemberModal = () => {
    if (isLoading) {
      return;
    }

    setMemberPendingRemoval(null);
  };

  const removeMember = async () => {
    if (!memberPendingRemoval) {
      return;
    }

    const member = memberPendingRemoval;
    setRemovingMemberId(member.userId);

    try {
      await runAction(async () => {
        const response = await client.removeHouseholdMember({ userId: member.userId });
        return response.household;
      });
      setMemberPendingRemoval(null);
    } finally {
      setRemovingMemberId(null);
    }
  };

  const leave = () =>
    runAction(
      async () => {
        const response = await client.leaveHousehold();
        return response.household;
      },
      {
        refreshAccountAfterward: true
      }
    );

  const handleRestorePurchases = () => {
    void restorePurchases().catch(() => undefined);
  };

  const closeInviteModal = () => {
    if (isLoading) {
      return;
    }

    setIsInviteModalVisible(false);
    setInviteEmail("");
  };

  const handleSignIn = () => {
    if (inviteParam) {
      router.push({
        pathname: "/account",
        params: {
          invite: inviteParam
        }
      });
      return;
    }

    router.push("/account" as never);
  };
  const renderMemberRow = (member: HouseholdMember) => (
    <View key={member.userId} style={styles.row}>
      <View style={styles.memberIdentity}>
        <View style={styles.memberAvatar}>
          <AppText style={styles.memberAvatarText}>{member.avatarEmoji ?? "LD"}</AppText>
        </View>
        <View style={styles.memberCopy}>
          <AppText numberOfLines={1} style={styles.memberName}>
            {getMemberName(member)}
          </AppText>
          <AppText muted numberOfLines={1} style={styles.memberEmail}>
            {member.email}
          </AppText>
        </View>
      </View>
      {household?.role === "owner" && member.role !== "owner" ? (
        <RemoveMemberButton
          disabled={isLoading}
          isRemoving={removingMemberId === member.userId}
          memberName={getMemberName(member)}
          onPress={() => setMemberPendingRemoval(member)}
        />
      ) : null}
    </View>
  );

  if (!hasLoadedAccount) {
    return (
      <View style={styles.screen}>
        <AppText muted>Checking account...</AppText>
      </View>
    );
  }

  if (!user) {
    return (
      <View style={styles.screen}>
        <AppSurface style={styles.card}>
          <AppText variant="title">Sign in required</AppText>
          <AppText muted>
            {inviteParam
              ? "Sign in to accept this LinkDish Family household invite."
              : "Sign in to create or join a LinkDish Family household."}
          </AppText>
          <AppButton
            label={inviteParam ? "Sign in to accept invite" : "Sign in"}
            onPress={handleSignIn}
          />
        </AppSurface>
      </View>
    );
  }

  return (
    <>
      <ScrollView contentContainerStyle={styles.container} showsVerticalScrollIndicator={false}>
        <AppSurface style={styles.card}>
          <AppText variant="title">Household</AppText>
          <AppText muted>
            LinkDish Family households share one monthly recipe import allowance across invited
            members.
          </AppText>
        </AppSurface>

        {error ? (
          <AppSurface style={styles.card} tone="subtle">
            <AppText>{error}</AppText>
          </AppSurface>
        ) : null}

        {household ? (
          <>
            <AppSurface style={styles.card}>
              <AppText variant="title">
                {household.role === "owner" ? "Your Family Household" : "Family Household"}
              </AppText>
              <AppText muted>
                {household.activeMemberCount} of {household.memberLimit} member slots are active.
                {household.cooldownSlotCount > 0
                  ? ` ${household.cooldownSlotCount} replacement ${
                      household.cooldownSlotCount === 1 ? "slot is" : "slots are"
                    } cooling down.`
                  : ""}
              </AppText>
              {!household.ownerFamilyEntitlementActive ? (
                <AppText>
                  The owner does not currently have an active LinkDish Family entitlement.
                </AppText>
              ) : null}
            </AppSurface>

            <AppSurface style={styles.card}>
              <View style={styles.membersHeader}>
                <AppText variant="title">Members</AppText>
                {household.role === "owner" ? (
                  <Pressable
                    accessibilityLabel="Invite member"
                    accessibilityRole="button"
                    disabled={isLoading}
                    onPress={() => setIsInviteModalVisible(true)}
                    style={({ pressed }) => [
                      styles.inviteMemberButton,
                      pressed && !isLoading && styles.iconButtonPressed,
                      isLoading && styles.iconButtonDisabled
                    ]}
                  >
                    <MaterialCommunityIcons color={appColors.accent} name="plus" size={22} />
                  </Pressable>
                ) : null}
              </View>
              <View style={styles.memberSection}>
                <AppText style={styles.memberSectionLabel} variant="label">
                  Owner
                </AppText>
                {groupedHouseholdMembers.owners.map(renderMemberRow)}
              </View>
              <View style={styles.memberSection}>
                <AppText style={styles.memberSectionLabel} variant="label">
                  Members
                </AppText>
                {groupedHouseholdMembers.members.length > 0 ? (
                  groupedHouseholdMembers.members.map(renderMemberRow)
                ) : (
                  <AppText muted>No members yet.</AppText>
                )}
              </View>
              {lastCreatedInvite ? (
                <View style={styles.inviteShareBox}>
                  <View style={styles.rowCopy}>
                    <AppText variant="label">Invite ready</AppText>
                    <AppText muted numberOfLines={1}>
                      {lastCreatedInvite.email}
                    </AppText>
                    <AppText>{lastCreatedInvite.inviteCode}</AppText>
                  </View>
                  <AppButton
                    disabled={isLoading}
                    label="Share code"
                    onPress={() => shareInvite(lastCreatedInvite)}
                    variant="secondary"
                  />
                </View>
              ) : null}
              {household.invites.length > 0 ? (
                <View style={styles.pendingList}>
                  <AppText variant="label">Pending invites</AppText>
                  {household.invites.map((invite) => (
                    <View key={invite.id} style={styles.row}>
                      <View style={styles.rowCopy}>
                        <AppText numberOfLines={1}>{invite.email}</AppText>
                        <AppText muted>{formatInviteExpiry(invite.expiresAt)}</AppText>
                      </View>
                      <AppButton
                        disabled={isLoading}
                        label="Cancel"
                        onPress={() => cancelInvite(invite.id, invite.email)}
                        variant="ghost"
                      />
                    </View>
                  ))}
                </View>
              ) : null}
            </AppSurface>

            {household.role !== "owner" ? (
              <AppSurface style={styles.card}>
                <AppButton disabled={isLoading} label="Leave household" onPress={leave} />
              </AppSurface>
            ) : null}
          </>
        ) : (
          <>
            <AppSurface style={styles.card}>
              <AppText variant="title">Join Household</AppText>
              <TextInput
                autoCapitalize="none"
                onChangeText={setInviteCode}
                placeholder="Invite code"
                placeholderTextColor={appColors.muted}
                style={styles.input}
                value={inviteCode}
              />
              <AppButton
                disabled={isLoading || inviteCode.trim().length < 8}
                label="Accept invite"
                onPress={acceptInvite}
              />
            </AppSurface>

            <AppSurface style={styles.card}>
              <AppText variant="title">Create Household</AppText>
              {hasFamilyPlan ? (
                <>
                  <AppText muted>
                    Create a household to share your LinkDish Family recipe imports with invited
                    members.
                  </AppText>
                  <AppButton
                    disabled={isLoading}
                    label="Create household"
                    onPress={createHousehold}
                  />
                </>
              ) : (
                <>
                  <AppText muted>LinkDish Family is required to create a household.</AppText>
                  <AppButton
                    label="View plans"
                    onPress={() => showUpgradeMoment("share_to_family_no_plan")}
                  />
                  {revenueCatConfigured ? (
                    <AppButton
                      disabled={isLoading || isRestoringPurchases}
                      label={isRestoringPurchases ? "Restoring purchases" : "Restore purchases"}
                      onPress={handleRestorePurchases}
                      variant="ghost"
                    />
                  ) : null}
                </>
              )}
            </AppSurface>
          </>
        )}
      </ScrollView>
      <Modal
        animationType="fade"
        onRequestClose={closeInviteModal}
        transparent
        visible={isInviteModalVisible}
      >
        <View style={styles.inviteModal}>
          <Pressable
            accessibilityLabel="Close invite member modal"
            accessibilityRole="button"
            onPress={closeInviteModal}
            style={styles.inviteModalBackdrop}
          />
          <AppSurface style={styles.inviteModalCard}>
            <View style={styles.inviteModalHeader}>
              <AppText variant="title">Invite Member</AppText>
              <Pressable
                accessibilityLabel="Close invite member modal"
                accessibilityRole="button"
                disabled={isLoading}
                hitSlop={10}
                onPress={closeInviteModal}
                style={({ pressed }) => [
                  styles.inviteModalClose,
                  pressed && !isLoading && styles.iconButtonPressed
                ]}
              >
                <MaterialCommunityIcons color={appColors.muted} name="close" size={20} />
              </Pressable>
            </View>
            <TextInput
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              onChangeText={setInviteEmail}
              placeholder="Member email"
              placeholderTextColor={appColors.muted}
              style={styles.input}
              value={inviteEmail}
            />
            {error ? (
              <AppText muted style={styles.inviteModalError}>
                {error}
              </AppText>
            ) : null}
            <View style={styles.inviteModalActions}>
              <AppButton
                disabled={isLoading || !inviteEmail.trim().includes("@")}
                label={isLoading ? "Sending" : "Send invite"}
                onPress={sendInvite}
              />
              <AppButton
                disabled={isLoading}
                label="Cancel"
                onPress={closeInviteModal}
                variant="ghost"
              />
            </View>
          </AppSurface>
        </View>
      </Modal>
      <Modal
        animationType="fade"
        onRequestClose={closeRemoveMemberModal}
        transparent
        visible={Boolean(memberPendingRemoval)}
      >
        <View style={styles.inviteModal}>
          <Pressable
            accessibilityLabel="Close remove member modal"
            accessibilityRole="button"
            onPress={closeRemoveMemberModal}
            style={styles.inviteModalBackdrop}
          />
          <AppSurface style={styles.removeMemberModalCard}>
            <View style={styles.removeMemberCopy}>
              <AppText style={styles.removeMemberTitle} variant="title">
                {memberPendingRemoval
                  ? `Remove ${getMemberName(memberPendingRemoval)}?`
                  : "Remove member?"}
              </AppText>
              {memberPendingRemoval ? (
                <AppText muted numberOfLines={1} style={styles.removeMemberEmail}>
                  {memberPendingRemoval.email}
                </AppText>
              ) : null}
              <AppText muted style={styles.removeMemberMessage}>
                They will lose access to this household and its shared recipes immediately.
              </AppText>
            </View>
            <View style={styles.removeMemberActions}>
              <Pressable
                accessibilityRole="button"
                disabled={isLoading}
                onPress={closeRemoveMemberModal}
                style={({ pressed }) => [
                  styles.cancelRemoveButton,
                  pressed && !isLoading && styles.confirmRemoveButtonPressed,
                  isLoading && styles.confirmRemoveButtonDisabled
                ]}
              >
                <AppText style={styles.cancelRemoveButtonText}>Cancel</AppText>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                disabled={isLoading}
                onPress={() => {
                  void removeMember();
                }}
                style={({ pressed }) => [
                  styles.confirmRemoveButton,
                  pressed && !isLoading && styles.confirmRemoveButtonPressed,
                  isLoading && styles.confirmRemoveButtonDisabled
                ]}
              >
                <AppText style={styles.confirmRemoveButtonText}>
                  {isLoading ? "Removing" : "Remove"}
                </AppText>
              </Pressable>
            </View>
          </AppSurface>
        </View>
      </Modal>
      <AppDialog
        actions={
          invitePendingCancellation
            ? [
                {
                  label: "Keep invite",
                  onPress: () => setInvitePendingCancellation(null),
                  variant: "outline"
                },
                {
                  label: "Cancel invite",
                  onPress: () => {
                    const inviteId = invitePendingCancellation.id;
                    setInvitePendingCancellation(null);
                    void runAction(async () => {
                      const response = await client.cancelHouseholdInvite({ inviteId });
                      setLastCreatedInvite((invite) => (invite?.id === inviteId ? null : invite));
                      return response.household;
                    });
                  },
                  variant: "danger"
                }
              ]
            : []
        }
        message={
          invitePendingCancellation
            ? `This stops ${invitePendingCancellation.email} from joining with this invite.`
            : ""
        }
        onRequestClose={() => setInvitePendingCancellation(null)}
        title="Cancel invite?"
        visible={invitePendingCancellation != null}
      />
    </>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: 14
  },
  cancelRemoveButton: {
    alignItems: "center",
    backgroundColor: appColors.canvas,
    borderColor: appColors.border,
    borderRadius: 16,
    borderWidth: 1,
    flex: 1,
    justifyContent: "center",
    minHeight: 52,
    paddingHorizontal: 18
  },
  cancelRemoveButtonText: {
    color: appColors.accent,
    fontSize: 15,
    fontWeight: "700",
    lineHeight: 20
  },
  container: {
    gap: 16,
    padding: 20,
    paddingBottom: 36
  },
  confirmRemoveButton: {
    alignItems: "center",
    backgroundColor: destructiveIconColor,
    borderRadius: 16,
    flex: 1,
    flexDirection: "row",
    gap: 8,
    justifyContent: "center",
    minHeight: 52,
    paddingHorizontal: 18
  },
  confirmRemoveButtonDisabled: {
    opacity: 0.54
  },
  confirmRemoveButtonPressed: {
    opacity: pressedOpacity.gentle,
    transform: [{ scale: 0.98 }]
  },
  confirmRemoveButtonText: {
    color: appColors.surface,
    fontSize: 15,
    fontWeight: "700",
    lineHeight: 20
  },
  input: {
    backgroundColor: appColors.canvas,
    borderColor: appColors.border,
    borderRadius: 14,
    borderWidth: 1,
    color: appColors.text,
    fontSize: 16,
    paddingHorizontal: 14,
    paddingVertical: 12
  },
  iconButtonDisabled: {
    opacity: 0.48
  },
  iconButtonPressed: {
    opacity: pressedOpacity.strong,
    transform: [{ scale: 0.96 }]
  },
  inviteMemberButton: {
    alignItems: "center",
    backgroundColor: appColors.accentSoft,
    borderRadius: 14,
    height: 44,
    justifyContent: "center",
    width: 44
  },
  inviteModal: {
    flex: 1,
    justifyContent: "center",
    padding: 20
  },
  inviteModalActions: {
    gap: 8
  },
  inviteModalBackdrop: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    top: 0,
    backgroundColor: "rgba(31, 33, 29, 0.28)"
  },
  inviteModalCard: {
    gap: 16
  },
  inviteModalClose: {
    alignItems: "center",
    backgroundColor: appColors.canvas,
    borderColor: appColors.border,
    borderRadius: 999,
    borderWidth: 1,
    height: 38,
    justifyContent: "center",
    width: 38
  },
  inviteModalHeader: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between"
  },
  inviteModalError: {
    color: appColors.danger,
    fontSize: 14,
    lineHeight: 18
  },
  inviteShareBox: {
    alignItems: "center",
    backgroundColor: appColors.canvas,
    borderColor: appColors.border,
    borderRadius: 14,
    borderWidth: 1,
    flexDirection: "row",
    gap: 12,
    justifyContent: "space-between",
    padding: 12
  },
  memberAvatar: {
    alignItems: "center",
    aspectRatio: 1,
    backgroundColor: appColors.accentSoft,
    borderColor: appColors.border,
    borderRadius: 13,
    borderWidth: 1,
    justifyContent: "center",
    width: 42
  },
  memberAvatarText: {
    color: appColors.accent,
    fontSize: 18,
    fontWeight: "700",
    lineHeight: 23
  },
  memberCopy: {
    flex: 1,
    gap: 6,
    minWidth: 0
  },
  memberEmail: {
    fontSize: 15,
    lineHeight: 20
  },
  memberIdentity: {
    alignItems: "center",
    flex: 1,
    flexDirection: "row",
    gap: 12,
    minWidth: 0
  },
  memberName: {
    flex: 1,
    fontSize: 17,
    fontWeight: "700",
    lineHeight: 22,
    minWidth: 0
  },
  memberSection: {
    gap: 12
  },
  memberSectionLabel: {
    marginTop: 2
  },
  membersHeader: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between"
  },
  pendingList: {
    gap: 10
  },
  removeButton: {
    alignItems: "center",
    borderRadius: 12,
    justifyContent: "center",
    minHeight: 44,
    width: 44
  },
  removeButtonFrame: {
    borderRadius: 12,
    width: 44
  },
  removeMemberCopy: {
    alignItems: "center",
    gap: 8
  },
  removeMemberEmail: {
    fontSize: 15,
    lineHeight: 20,
    textAlign: "center",
    width: "100%"
  },
  removeMemberMessage: {
    fontSize: 16,
    lineHeight: 22,
    textAlign: "center"
  },
  removeMemberModalCard: {
    gap: 16,
    paddingBottom: 18,
    paddingHorizontal: 18,
    paddingTop: 18
  },
  removeMemberActions: {
    flexDirection: "row",
    gap: 10
  },
  removeMemberTitle: {
    maxWidth: "92%",
    textAlign: "center"
  },
  row: {
    alignItems: "center",
    borderColor: appColors.border,
    borderRadius: 14,
    borderWidth: 1,
    flexDirection: "row",
    gap: 12,
    justifyContent: "space-between",
    paddingHorizontal: 14,
    paddingVertical: 16
  },
  rowCopy: {
    flex: 1,
    gap: 2
  },
  screen: {
    flex: 1,
    justifyContent: "center",
    padding: 20
  }
});
