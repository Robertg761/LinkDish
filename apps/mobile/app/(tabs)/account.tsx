import { useSignInWithApple } from "@clerk/expo/apple";
import { useSignInWithGoogle } from "@clerk/expo/google";
import { ExtractorApiError, createExtractorApiClient } from "@linkdish/api-client";
import { AppButton, AppSurface, AppText } from "@linkdish/ui";
import "expo-crypto";
import { router, useLocalSearchParams } from "expo-router";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  Easing,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppDialog } from "../../src/components/AppDialog";
import { mobileEnv } from "../../src/config/env";
import { useAccount } from "../../src/features/account/AccountContext";
import { useClerkSession } from "../../src/features/account/ClerkSessionContext";
import { useBilling } from "../../src/features/billing/BillingContext";
import { useSavedRecipes } from "../../src/features/saved-recipes/SavedRecipesContext";
import { pressedOpacity } from "../../src/theme/interactions";
import { appColors, appSpacing } from "../../src/theme/tokens";

const isAppleSignInEnabled = process.env.EXPO_PUBLIC_CLERK_APPLE_SIGN_IN_ENABLED === "true";
const profileEmojiOptions = ["🍳", "🥘", "🥗", "🍜", "🍕", "🥐", "🌶️", "🍰", "🍔", "🍣", "🍪"];
const emojiGlyphPattern = /[\p{Extended_Pictographic}\p{Regional_Indicator}]|[#*0-9]\uFE0F?\u20E3/u;
const emojiPickerSections = [
  {
    emojis: [
      "🍳",
      "🥘",
      "🥗",
      "🍜",
      "🍕",
      "🥐",
      "🌶️",
      "🍰",
      "🍔",
      "🍣",
      "🍪",
      "🍎",
      "🍓",
      "🍇",
      "🍉",
      "🍍",
      "🥑",
      "🥕",
      "🌽",
      "🥨",
      "🧀",
      "🥞",
      "🧇",
      "🍩",
      "🍫",
      "🍿",
      "☕",
      "🧋"
    ],
    label: "Food"
  },
  {
    emojis: [
      "😀",
      "😄",
      "😁",
      "😊",
      "🙂",
      "😍",
      "😋",
      "😎",
      "🤩",
      "🥳",
      "😌",
      "🤓",
      "😇",
      "🥰",
      "😆",
      "😂",
      "🙃",
      "😉"
    ],
    label: "Faces"
  },
  {
    emojis: [
      "👋",
      "👍",
      "🙌",
      "👏",
      "💪",
      "🤌",
      "👌",
      "🙏",
      "🫶",
      "👨‍🍳",
      "👩‍🍳",
      "🧑‍🍳",
      "👨‍👩‍👧‍👦",
      "❤️",
      "✨",
      "⭐",
      "🔥",
      "💯"
    ],
    label: "People"
  },
  {
    emojis: [
      "🐶",
      "🐱",
      "🐻",
      "🐼",
      "🦊",
      "🐸",
      "🐵",
      "🦁",
      "🐷",
      "🐢",
      "🦋",
      "🌻",
      "🌿",
      "🍄",
      "🌙",
      "☀️",
      "🌈",
      "❄️"
    ],
    label: "Nature"
  },
  {
    emojis: [
      "🏃",
      "🚴",
      "🏕️",
      "🎨",
      "🎧",
      "🎮",
      "🎲",
      "🎯",
      "⚽",
      "🏀",
      "🏈",
      "⚾",
      "🎸",
      "🎬",
      "📚",
      "✈️",
      "🚗",
      "🏠"
    ],
    label: "More"
  }
] as const;

type GraphemeSegmenter = {
  segment: (value: string) => Iterable<{ segment: string }>;
};

type EmojiPickerSectionLabel = (typeof emojiPickerSections)[number]["label"];
const defaultEmojiPickerSection: EmojiPickerSectionLabel = "Food";

type IntlWithSegmenter = typeof Intl & {
  Segmenter?: new (
    locales: string | string[],
    options: { granularity: "grapheme" }
  ) => GraphemeSegmenter;
};

const getProfileName = (user: { displayName?: string | null | undefined; email: string }): string =>
  user.displayName?.trim() || user.email;

const getAccountActionErrorMessage = (error: unknown): string => {
  if (error instanceof ExtractorApiError && typeof error.details === "object" && error.details) {
    const message = (error.details as { message?: unknown }).message;

    if (typeof message === "string" && message.trim()) {
      return message;
    }
  }

  return error instanceof Error ? error.message : "LinkDish account action failed.";
};

const isAlreadySignedInClerkError = (error: unknown): boolean => {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "object" && error !== null && "message" in error
        ? String((error as { message?: unknown }).message)
        : "";

  return message.toLowerCase().includes("already signed in");
};

const getProfilePayload = (displayName: string, avatarEmoji: string) => ({
  avatarEmoji: avatarEmoji.trim() || null,
  displayName: displayName.trim() || null
});

const getOptionalProfilePayload = (displayName: string, avatarEmoji: string) => {
  const payload = getProfilePayload(displayName, avatarEmoji);

  return {
    ...(payload.avatarEmoji ? { avatarEmoji: payload.avatarEmoji } : {}),
    ...(payload.displayName ? { displayName: payload.displayName } : {})
  };
};

const getEmojiGlyphs = (value: string): string[] => {
  const trimmedValue = value.trim();
  const Segmenter = (Intl as IntlWithSegmenter).Segmenter;

  if (Segmenter) {
    return Array.from(
      new Segmenter("en", { granularity: "grapheme" }).segment(trimmedValue),
      ({ segment }) => segment
    );
  }

  return Array.from(trimmedValue);
};

const getFirstEmojiGlyph = (value: string): string => {
  const emojiGlyph = getEmojiGlyphs(value).find((segment) => emojiGlyphPattern.test(segment));

  return emojiGlyph ?? "";
};

const EmojiPicker = ({
  disabled,
  selectedEmoji,
  onSelect
}: {
  disabled: boolean;
  selectedEmoji: string;
  onSelect: (emoji: string) => void;
}) => {
  const [isCustomPickerVisible, setIsCustomPickerVisible] = useState(false);
  const [activePickerSection, setActivePickerSection] =
    useState<EmojiPickerSectionLabel>(defaultEmojiPickerSection);
  const emojiPickerProgress = useRef(new Animated.Value(0)).current;
  const customEmojiSelected =
    Boolean(selectedEmoji) && !profileEmojiOptions.includes(selectedEmoji);
  const activeEmojiOptions =
    emojiPickerSections.find((section) => section.label === activePickerSection)?.emojis ??
    profileEmojiOptions;
  const emojiPickerBackdropOpacity = emojiPickerProgress.interpolate({
    inputRange: [0, 1],
    outputRange: [0, 1]
  });
  const emojiPickerSheetTranslateY = emojiPickerProgress.interpolate({
    inputRange: [0, 1],
    outputRange: [20, 0]
  });

  useEffect(() => {
    if (!isCustomPickerVisible) {
      return;
    }

    emojiPickerProgress.setValue(0);
    Animated.timing(emojiPickerProgress, {
      duration: 160,
      easing: Easing.out(Easing.cubic),
      toValue: 1,
      useNativeDriver: true
    }).start();
  }, [emojiPickerProgress, isCustomPickerVisible]);

  const showCustomPicker = () => {
    setIsCustomPickerVisible(true);
  };

  const hideCustomPicker = () => {
    Animated.timing(emojiPickerProgress, {
      duration: 120,
      easing: Easing.in(Easing.cubic),
      toValue: 0,
      useNativeDriver: true
    }).start(({ finished }) => {
      if (finished) {
        setIsCustomPickerVisible(false);
      }
    });
  };

  const handleCustomEmojiSelect = (emoji: string) => {
    onSelect(emoji);
    hideCustomPicker();
  };

  const handleCustomEmojiTextInput = (value: string) => {
    const nextEmoji = getFirstEmojiGlyph(value);

    if (nextEmoji) {
      handleCustomEmojiSelect(nextEmoji);
    }
  };

  return (
    <View style={styles.emojiPicker}>
      <View style={styles.emojiGrid}>
        {profileEmojiOptions.map((emoji) => {
          const isSelected = selectedEmoji === emoji;

          return (
            <Pressable
              accessibilityLabel={`Use ${emoji} as profile emoji`}
              accessibilityRole="button"
              disabled={disabled}
              key={emoji}
              onPress={() => onSelect(isSelected ? "" : emoji)}
              style={({ pressed }) => [
                styles.emojiOption,
                isSelected && styles.emojiOptionSelected,
                pressed && !disabled && styles.emojiOptionPressed,
                disabled && styles.emojiOptionDisabled
              ]}
            >
              <AppText style={styles.emojiOptionText}>{emoji}</AppText>
            </Pressable>
          );
        })}
        <View style={styles.customEmojiSlot}>
          <Pressable
            accessibilityLabel="Choose any profile emoji"
            accessibilityRole="button"
            disabled={disabled}
            onPress={showCustomPicker}
            style={({ pressed }) => [
              styles.emojiOption,
              customEmojiSelected && styles.emojiOptionSelected,
              pressed && !disabled && styles.emojiOptionPressed,
              disabled && styles.emojiOptionDisabled
            ]}
          >
            <AppText style={styles.emojiOptionText}>
              {customEmojiSelected ? selectedEmoji : "+"}
            </AppText>
          </Pressable>
        </View>
      </View>
      <Modal
        animationType="none"
        onRequestClose={hideCustomPicker}
        transparent
        visible={isCustomPickerVisible}
      >
        <View style={styles.emojiPickerModal}>
          <Pressable
            accessibilityLabel="Close emoji picker"
            accessibilityRole="button"
            onPress={hideCustomPicker}
            style={styles.emojiPickerBackdropTapTarget}
          >
            <Animated.View
              style={[
                styles.emojiPickerBackdrop,
                {
                  opacity: emojiPickerBackdropOpacity
                }
              ]}
            />
          </Pressable>
          <Animated.View
            style={[
              styles.emojiPickerSheetFrame,
              {
                opacity: emojiPickerProgress,
                transform: [{ translateY: emojiPickerSheetTranslateY }]
              }
            ]}
          >
            <AppSurface style={styles.emojiPickerSheet}>
              <View style={styles.emojiPickerSheetHandle} />
              <View style={styles.emojiPickerHeader}>
                <AppText variant="title">Choose Emoji</AppText>
                <Pressable
                  accessibilityLabel="Close emoji picker"
                  accessibilityRole="button"
                  hitSlop={10}
                  onPress={hideCustomPicker}
                  style={({ pressed }) => [
                    styles.emojiPickerClose,
                    pressed && styles.emojiOptionPressed
                  ]}
                >
                  <AppText style={styles.emojiPickerCloseText}>x</AppText>
                </Pressable>
              </View>
              <ScrollView
                contentContainerStyle={styles.emojiPickerTabs}
                horizontal
                showsHorizontalScrollIndicator={false}
              >
                {emojiPickerSections.map((section) => {
                  const isActive = activePickerSection === section.label;

                  return (
                    <Pressable
                      accessibilityLabel={`Show ${section.label} emoji`}
                      accessibilityRole="button"
                      key={section.label}
                      onPress={() => setActivePickerSection(section.label)}
                      style={({ pressed }) => [
                        styles.emojiPickerTab,
                        isActive && styles.emojiPickerTabActive,
                        pressed && styles.emojiOptionPressed
                      ]}
                    >
                      <AppText
                        style={[
                          styles.emojiPickerTabText,
                          isActive && styles.emojiPickerTabTextActive
                        ]}
                      >
                        {section.label}
                      </AppText>
                    </Pressable>
                  );
                })}
              </ScrollView>
              <ScrollView
                contentContainerStyle={styles.emojiPickerChoices}
                showsVerticalScrollIndicator={false}
              >
                {activeEmojiOptions.map((emoji) => {
                  const isSelected = selectedEmoji === emoji;

                  return (
                    <Pressable
                      accessibilityLabel={`Use ${emoji} as profile emoji`}
                      accessibilityRole="button"
                      key={emoji}
                      onPress={() => handleCustomEmojiSelect(emoji)}
                      style={({ pressed }) => [
                        styles.emojiPickerChoice,
                        isSelected && styles.emojiOptionSelected,
                        pressed && styles.emojiOptionPressed
                      ]}
                    >
                      <AppText style={styles.emojiPickerChoiceText}>{emoji}</AppText>
                    </Pressable>
                  );
                })}
              </ScrollView>
              <TextInput
                autoCapitalize="none"
                autoCorrect={false}
                maxLength={16}
                onChangeText={handleCustomEmojiTextInput}
                placeholder="Paste emoji"
                placeholderTextColor={appColors.muted}
                style={styles.emojiPickerPasteInput}
                value=""
              />
            </AppSurface>
          </Animated.View>
        </View>
      </Modal>
    </View>
  );
};

const ClerkSignInActions = ({ disabled }: { disabled: boolean }) => {
  const { refreshAccount } = useAccount();
  const clerkSession = useClerkSession();
  const { startAppleAuthenticationFlow } = useSignInWithApple();
  const { startGoogleAuthenticationFlow } = useSignInWithGoogle();
  const [signInErrorVisible, setSignInErrorVisible] = useState(false);

  const completeClerkSignIn = async (
    startFlow: () => Promise<{
      createdSessionId: string | null;
      setActive?: (params: { session: string }) => Promise<void>;
    }>
  ) => {
    try {
      if (clerkSession.isSignedIn) {
        await refreshAccount();
        return;
      }

      const { createdSessionId, setActive } = await startFlow();

      if (createdSessionId && setActive) {
        await setActive({ session: createdSessionId });
      }

      await refreshAccount();
    } catch (error) {
      if (isAlreadySignedInClerkError(error)) {
        try {
          await refreshAccount();
          return;
        } catch (refreshError) {
          console.warn(
            "Failed to refresh LinkDish account for active Clerk session.",
            refreshError
          );
        }
      }

      console.warn("Clerk sign-in failed.", error);
      setSignInErrorVisible(true);
    }
  };

  return (
    <>
      <View style={styles.actions}>
        <AppButton
          disabled={disabled}
          label="Continue with Google"
          onPress={() => completeClerkSignIn(() => startGoogleAuthenticationFlow())}
        />
        {isAppleSignInEnabled && Platform.OS === "ios" ? (
          <AppButton
            disabled={disabled}
            label="Continue with Apple"
            onPress={() => completeClerkSignIn(() => startAppleAuthenticationFlow())}
            variant="outline"
          />
        ) : null}
      </View>
      <AppDialog
        actions={[
          {
            label: "OK",
            onPress: () => setSignInErrorVisible(false)
          }
        ]}
        message="LinkDish could not complete sign in. Please try again."
        onRequestClose={() => setSignInErrorVisible(false)}
        title="Sign in failed"
        visible={signInErrorVisible}
      />
    </>
  );
};

export default function AccountScreen() {
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ invite?: string | string[] }>();
  const inviteParam = Array.isArray(params.invite) ? params.invite[0] : params.invite;
  const returnInviteCode = inviteParam?.trim() ?? "";
  const {
    accountError,
    deleteAccount,
    getAuthHeaders,
    hasLoadedAccount,
    isAccountBusy,
    isClerkSignInEnabled,
    isEmailCodeSignInEnabled,
    logout,
    refreshAccount,
    requestCode,
    signInWithDebugHousehold,
    updateProfile,
    user,
    verifyCode
  } = useAccount();
  const { restorePurchases, purchaseStatus } = useBilling();
  const { refreshSharedRecipes } = useSavedRecipes();
  const [code, setCode] = useState("");
  const [confirmEmail, setConfirmEmail] = useState("");
  const [email, setEmail] = useState("");
  const [hasRequestedCode, setHasRequestedCode] = useState(false);
  const [inviteCode, setInviteCode] = useState("");
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [isJoinHouseholdModalVisible, setIsJoinHouseholdModalVisible] = useState(false);
  const [isDeleteAccountDialogVisible, setIsDeleteAccountDialogVisible] = useState(false);
  const [isJoiningHousehold, setIsJoiningHousehold] = useState(false);
  const [profileAvatarEmoji, setProfileAvatarEmoji] = useState("");
  const [profileDisplayName, setProfileDisplayName] = useState("");
  const [profileSavedMessage, setProfileSavedMessage] = useState<string | null>(null);
  const [signupAvatarEmoji, setSignupAvatarEmoji] = useState("");
  const [signupDisplayName, setSignupDisplayName] = useState("");
  const isBusy = isAccountBusy || purchaseStatus === "restoring" || isJoiningHousehold;
  const householdClient = useMemo(
    () =>
      createExtractorApiClient({
        baseUrl: mobileEnv.apiBaseUrl,
        getHeaders: getAuthHeaders
      }),
    [getAuthHeaders]
  );
  const nextProfile = getProfilePayload(profileDisplayName, profileAvatarEmoji);
  const isProfileDirty =
    Boolean(user) &&
    (nextProfile.displayName !== (user?.displayName ?? null) ||
      nextProfile.avatarEmoji !== (user?.avatarEmoji ?? null));
  const profileAvatarPreview = profileAvatarEmoji.trim() || "LD";

  useEffect(() => {
    if (!hasLoadedAccount || !user || !returnInviteCode) {
      return;
    }

    router.replace({
      pathname: "/household",
      params: {
        invite: returnInviteCode
      }
    });
  }, [hasLoadedAccount, returnInviteCode, user]);

  useEffect(() => {
    setProfileAvatarEmoji(user?.avatarEmoji ?? "");
    setProfileDisplayName(user?.displayName ?? "");
    setProfileSavedMessage(null);
  }, [user?.avatarEmoji, user?.displayName, user?.id]);

  const handleRequestCode = () => {
    void requestCode(email)
      .then(() => setHasRequestedCode(true))
      .catch(() => undefined);
  };

  const handleVerifyCode = () => {
    void verifyCode(email, code, getOptionalProfilePayload(signupDisplayName, signupAvatarEmoji))
      .then(() => {
        setCode("");
        setHasRequestedCode(false);
        setSignupAvatarEmoji("");
        setSignupDisplayName("");
      })
      .catch(() => undefined);
  };

  const handleSaveProfile = () => {
    void updateProfile(nextProfile)
      .then(() => setProfileSavedMessage("Profile saved."))
      .catch(() => undefined);
  };

  const handleRestorePurchases = () => {
    void restorePurchases().catch(() => undefined);
  };

  const openJoinHouseholdModal = () => {
    setInviteError(null);
    setIsJoinHouseholdModalVisible(true);
  };

  const closeJoinHouseholdModal = () => {
    if (isJoiningHousehold) {
      return;
    }

    setInviteCode("");
    setInviteError(null);
    setIsJoinHouseholdModalVisible(false);
  };

  const handleJoinHousehold = () => {
    const trimmedInviteCode = inviteCode.trim();

    if (!trimmedInviteCode) {
      return;
    }

    setInviteError(null);
    setIsJoiningHousehold(true);

    void householdClient
      .acceptHouseholdInvite({ inviteCode: trimmedInviteCode })
      .then(async () => {
        await refreshAccount();
        await refreshSharedRecipes();
        setInviteCode("");
        setIsJoinHouseholdModalVisible(false);
        setIsJoiningHousehold(false);
        router.push("/household" as never);
      })
      .catch((error) => {
        setInviteError(getAccountActionErrorMessage(error));
        setIsJoiningHousehold(false);
      });
  };

  const handleDebugHouseholdSignIn = () => {
    void signInWithDebugHousehold()
      .then(() => router.replace("/household" as never))
      .catch(() => undefined);
  };

  const handleLogout = () => {
    void logout().catch(() => undefined);
  };

  const handleDeleteAccount = () => {
    if (!user) {
      return;
    }

    setIsDeleteAccountDialogVisible(true);
  };

  if (!hasLoadedAccount) {
    return (
      <View style={styles.screen}>
        <AppText muted>Checking account...</AppText>
      </View>
    );
  }

  return (
    <>
      <ScrollView
        contentContainerStyle={[
          styles.container,
          {
            paddingBottom: Math.max(insets.bottom, appSpacing.xl) + 96,
            paddingTop: Math.max(insets.top, appSpacing.lg) + appSpacing.lg
          }
        ]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.householdHeader}>
          <AppText style={styles.householdTitle} variant="display">
            Household
          </AppText>
          <AppText muted style={styles.householdIntro}>
            Profile, Family sharing, plans, and account settings.
          </AppText>
        </View>

        {accountError ? (
          <AppSurface style={styles.card} tone="subtle">
            <AppText>{accountError}</AppText>
          </AppSurface>
        ) : null}

        {user ? (
          <>
            <AppSurface style={[styles.card, styles.settingsCard]}>
              <View style={styles.profileHeader}>
                <View style={styles.profileAvatar}>
                  <AppText style={styles.profileAvatarText}>{profileAvatarPreview}</AppText>
                </View>
                <View style={styles.profileHeaderCopy}>
                  <AppText style={styles.centeredText} variant="title">
                    {getProfileName(user)}
                  </AppText>
                  <AppText muted style={styles.centeredText}>
                    {user.email}
                  </AppText>
                </View>
              </View>
              <TextInput
                autoCapitalize="words"
                maxLength={40}
                onChangeText={(value) => {
                  setProfileDisplayName(value);
                  setProfileSavedMessage(null);
                }}
                placeholder="Display name"
                placeholderTextColor={appColors.muted}
                style={[styles.input, styles.centeredInput]}
                value={profileDisplayName}
              />
              <EmojiPicker
                disabled={isBusy}
                onSelect={(emoji) => {
                  setProfileAvatarEmoji(emoji);
                  setProfileSavedMessage(null);
                }}
                selectedEmoji={profileAvatarEmoji}
              />
              <View style={styles.profileActions}>
                <AppButton
                  disabled={isBusy || !isProfileDirty}
                  label="Save profile"
                  onPress={handleSaveProfile}
                />
                {profileSavedMessage ? <AppText muted>{profileSavedMessage}</AppText> : null}
              </View>
            </AppSurface>

            <AppSurface style={[styles.card, styles.settingsCard]}>
              <View style={[styles.actions, styles.accountActions]}>
                <View style={styles.accountPrimaryActions}>
                  <AppButton
                    label="Manage Household"
                    onPress={() => router.push("/household" as never)}
                    style={styles.accountPrimaryButton}
                    variant="outline"
                  />
                  <AppButton
                    disabled={isBusy}
                    label="Join Household"
                    onPress={openJoinHouseholdModal}
                    style={styles.accountPrimaryButton}
                    variant="outline"
                  />
                  <AppButton
                    label="View Plans"
                    onPress={() => router.push("/upgrade" as never)}
                    style={styles.accountPrimaryButton}
                    variant="outline"
                  />
                </View>
                <View style={styles.accountSecondaryActions}>
                  <AppButton
                    disabled={isBusy}
                    label={purchaseStatus === "restoring" ? "Restoring" : "Restore purchases"}
                    onPress={handleRestorePurchases}
                    style={styles.accountSplitButton}
                    variant="outline"
                  />
                  <AppButton
                    disabled={isBusy}
                    label="Sign out"
                    onPress={handleLogout}
                    style={styles.accountSplitButton}
                    variant="outline-danger"
                  />
                </View>
              </View>
            </AppSurface>

            <AppSurface style={[styles.card, styles.settingsCard]}>
              <AppText style={styles.centeredText} variant="title">
                Delete Account
              </AppText>
              <AppText muted style={styles.centeredText}>
                Deleting your account removes server-side account, household, and shared Family
                recipe records that belong to the account. Recipes saved on this device stay on this
                device.
              </AppText>
              <TextInput
                autoCapitalize="none"
                keyboardType="email-address"
                onChangeText={setConfirmEmail}
                placeholder="Confirm your email"
                placeholderTextColor={appColors.muted}
                style={[styles.input, styles.centeredInput]}
                value={confirmEmail}
              />
              <AppButton
                disabled={isBusy || confirmEmail.trim().toLowerCase() !== user.email.toLowerCase()}
                label="Delete account"
                onPress={handleDeleteAccount}
                variant="outline-danger"
              />
            </AppSurface>
          </>
        ) : (
          <>
            {isClerkSignInEnabled ? (
              <AppSurface style={[styles.card, styles.settingsCard]}>
                <ClerkSignInActions disabled={isBusy} />
              </AppSurface>
            ) : null}

            {isClerkSignInEnabled && isEmailCodeSignInEnabled ? (
              <View style={styles.signInSeparator}>
                <View style={styles.signInSeparatorLine} />
                <AppText muted style={styles.signInSeparatorText}>
                  OR
                </AppText>
                <View style={styles.signInSeparatorLine} />
              </View>
            ) : null}

            {isEmailCodeSignInEnabled ? (
              <AppSurface style={[styles.card, styles.settingsCard]}>
                <TextInput
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="email-address"
                  onChangeText={setEmail}
                  placeholder="Email address"
                  placeholderTextColor={appColors.muted}
                  style={[styles.input, styles.centeredInput]}
                  value={email}
                />
                {hasRequestedCode ? (
                  <>
                    <TextInput
                      keyboardType="number-pad"
                      maxLength={6}
                      onChangeText={setCode}
                      placeholder="6-digit code"
                      placeholderTextColor={appColors.muted}
                      style={[styles.input, styles.centeredInput]}
                      value={code}
                    />
                    <View style={styles.signupProfile}>
                      <AppText style={styles.centeredText} variant="label">
                        Optional profile
                      </AppText>
                      <TextInput
                        autoCapitalize="words"
                        maxLength={40}
                        onChangeText={setSignupDisplayName}
                        placeholder="Display name"
                        placeholderTextColor={appColors.muted}
                        style={[styles.input, styles.centeredInput]}
                        value={signupDisplayName}
                      />
                      <EmojiPicker
                        disabled={isBusy}
                        onSelect={setSignupAvatarEmoji}
                        selectedEmoji={signupAvatarEmoji}
                      />
                    </View>
                  </>
                ) : null}
                <View style={styles.actions}>
                  <AppButton
                    disabled={isBusy || !email.includes("@")}
                    label={hasRequestedCode ? "Send new code" : "Email sign-in code"}
                    onPress={handleRequestCode}
                    variant="outline"
                  />
                  {hasRequestedCode ? (
                    <AppButton
                      disabled={isBusy || code.trim().length !== 6}
                      label="Verify code"
                      onPress={handleVerifyCode}
                      variant="outline"
                    />
                  ) : null}
                </View>
              </AppSurface>
            ) : null}

            {!isClerkSignInEnabled && !isEmailCodeSignInEnabled ? (
              <AppSurface style={[styles.card, styles.settingsCard]}>
                <AppText muted style={styles.centeredText}>
                  Sign-in is temporarily unavailable.
                </AppText>
              </AppSurface>
            ) : null}

            {(process.env.NODE_ENV === "test" || (typeof __DEV__ !== "undefined" && __DEV__)) &&
            mobileEnv.debugHouseholdSimulatorEnabled ? (
              <AppSurface style={[styles.card, styles.settingsCard]}>
                <AppButton
                  disabled={isBusy}
                  label="Use simulated household"
                  onPress={handleDebugHouseholdSignIn}
                  variant="outline"
                />
              </AppSurface>
            ) : null}
          </>
        )}
      </ScrollView>
      <Modal
        animationType="fade"
        onRequestClose={closeJoinHouseholdModal}
        transparent
        visible={isJoinHouseholdModalVisible}
      >
        <View style={styles.joinModal}>
          <Pressable
            accessibilityLabel="Close join household"
            accessibilityRole="button"
            disabled={isJoiningHousehold}
            onPress={closeJoinHouseholdModal}
            style={styles.joinModalBackdropTapTarget}
          >
            <View style={styles.joinModalBackdrop} />
          </Pressable>
          <AppSurface style={styles.joinModalSheet}>
            <AppText style={styles.centeredText} variant="title">
              Join Household
            </AppText>
            <TextInput
              autoCapitalize="none"
              autoCorrect={false}
              onChangeText={(value) => {
                setInviteCode(value);
                setInviteError(null);
              }}
              onSubmitEditing={handleJoinHousehold}
              placeholder="Invite code"
              placeholderTextColor={appColors.muted}
              returnKeyType="done"
              style={[styles.input, styles.centeredInput]}
              value={inviteCode}
            />
            {inviteError ? (
              <AppText style={[styles.centeredText, styles.errorText]}>{inviteError}</AppText>
            ) : null}
            <View style={styles.joinModalActions}>
              <AppButton
                disabled={isJoiningHousehold}
                label="Cancel"
                onPress={closeJoinHouseholdModal}
                style={styles.joinModalButton}
                variant="outline"
              />
              <AppButton
                disabled={isJoiningHousehold || !inviteCode.trim()}
                label={isJoiningHousehold ? "Joining" : "Accept invite"}
                onPress={handleJoinHousehold}
                style={styles.joinModalButton}
              />
            </View>
          </AppSurface>
        </View>
      </Modal>
      <AppDialog
        actions={[
          {
            disabled: isAccountBusy,
            label: "Cancel",
            onPress: () => setIsDeleteAccountDialogVisible(false),
            variant: "outline"
          },
          {
            disabled: isAccountBusy,
            label: isAccountBusy ? "Deleting" : "Delete",
            onPress: () => {
              setIsDeleteAccountDialogVisible(false);
              void deleteAccount(confirmEmail)
                .then(() => router.replace("/" as never))
                .catch(() => undefined);
            },
            variant: "danger"
          }
        ]}
        message="This removes your LinkDish account, household membership, and shared Family recipes you added. Store subscriptions are still managed by Apple or Google."
        onRequestClose={() => {
          if (!isAccountBusy) {
            setIsDeleteAccountDialogVisible(false);
          }
        }}
        title="Delete account"
        visible={isDeleteAccountDialogVisible}
      />
    </>
  );
}

const styles = StyleSheet.create({
  accountActions: {
    width: "100%"
  },
  accountPrimaryActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    width: "100%"
  },
  accountPrimaryButton: {
    flex: 1,
    minWidth: 140,
    paddingHorizontal: 12
  },
  accountSecondaryActions: {
    flexDirection: "row",
    gap: 10,
    width: "100%"
  },
  accountSplitButton: {
    flex: 1,
    paddingHorizontal: 12
  },
  actions: {
    gap: 10
  },
  card: {
    gap: 14
  },
  centeredInput: {
    textAlign: "center",
    width: "100%"
  },
  centeredText: {
    textAlign: "center"
  },
  container: {
    gap: 16,
    padding: 20,
    paddingBottom: 36
  },
  householdHeader: {
    alignItems: "flex-start",
    gap: 8,
    paddingBottom: 4
  },
  householdIntro: {
    fontSize: 15,
    lineHeight: 22,
    textAlign: "left"
  },
  householdTitle: {
    color: appColors.text,
    fontSize: 42,
    lineHeight: 50,
    textAlign: "left"
  },
  emojiGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    justifyContent: "center"
  },
  emojiOption: {
    alignItems: "center",
    aspectRatio: 1,
    backgroundColor: appColors.canvas,
    borderColor: appColors.border,
    borderRadius: 12,
    borderWidth: 1,
    justifyContent: "center",
    width: 46
  },
  emojiOptionDisabled: {
    opacity: 0.5
  },
  emojiOptionPressed: {
    opacity: pressedOpacity.strong,
    transform: [{ scale: 0.97 }]
  },
  emojiOptionSelected: {
    backgroundColor: appColors.accentSoft,
    borderColor: appColors.accent
  },
  emojiOptionText: {
    fontSize: 24,
    lineHeight: 30
  },
  emojiPicker: {
    alignItems: "center",
    position: "relative",
    width: "100%"
  },
  emojiPickerBackdrop: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    top: 0,
    backgroundColor: "rgba(246, 240, 229, 0.62)"
  },
  emojiPickerBackdropTapTarget: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    top: 0
  },
  emojiPickerChoice: {
    alignItems: "center",
    aspectRatio: 1,
    backgroundColor: appColors.canvas,
    borderColor: appColors.border,
    borderRadius: 12,
    borderWidth: 1,
    justifyContent: "center",
    width: 52
  },
  emojiPickerChoices: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    paddingBottom: 4
  },
  emojiPickerChoiceText: {
    fontSize: 27,
    lineHeight: 34
  },
  emojiPickerClose: {
    alignItems: "center",
    aspectRatio: 1,
    backgroundColor: appColors.canvas,
    borderColor: appColors.border,
    borderRadius: 999,
    borderWidth: 1,
    justifyContent: "center",
    width: 38
  },
  emojiPickerCloseText: {
    color: appColors.muted,
    fontSize: 18,
    fontWeight: "700",
    lineHeight: 22
  },
  emojiPickerHeader: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between"
  },
  emojiPickerModal: {
    flex: 1,
    justifyContent: "flex-end"
  },
  emojiPickerPasteInput: {
    backgroundColor: appColors.canvas,
    borderColor: appColors.border,
    borderRadius: 12,
    borderWidth: 1,
    color: appColors.text,
    fontSize: 15,
    minHeight: 46,
    paddingHorizontal: 14,
    paddingVertical: 10
  },
  emojiPickerSheet: {
    borderBottomLeftRadius: 0,
    borderBottomRightRadius: 0,
    gap: 14,
    maxHeight: "100%",
    paddingBottom: 24
  },
  emojiPickerSheetFrame: {
    maxHeight: "78%",
    width: "100%"
  },
  emojiPickerSheetHandle: {
    alignSelf: "center",
    backgroundColor: appColors.border,
    borderRadius: 999,
    height: 4,
    width: 42
  },
  emojiPickerTab: {
    alignItems: "center",
    backgroundColor: appColors.canvas,
    borderColor: appColors.border,
    borderRadius: 999,
    borderWidth: 1,
    justifyContent: "center",
    minHeight: 46,
    paddingHorizontal: 13,
    paddingVertical: 8
  },
  emojiPickerTabActive: {
    backgroundColor: appColors.accent,
    borderColor: appColors.accent
  },
  emojiPickerTabs: {
    alignItems: "center",
    gap: 8,
    paddingRight: 4
  },
  emojiPickerTabText: {
    color: appColors.muted,
    fontSize: 13,
    fontWeight: "700",
    lineHeight: 18
  },
  emojiPickerTabTextActive: {
    color: appColors.canvas
  },
  errorText: {
    color: appColors.danger
  },
  customEmojiSlot: {
    height: 46,
    position: "relative",
    width: 46
  },
  input: {
    backgroundColor: appColors.canvas,
    borderColor: appColors.border,
    borderRadius: 12,
    borderWidth: 1,
    color: appColors.text,
    fontSize: 16,
    paddingHorizontal: 14,
    paddingVertical: 12
  },
  joinModal: {
    alignItems: "center",
    flex: 1,
    justifyContent: "center",
    padding: 20
  },
  joinModalActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    width: "100%"
  },
  joinModalBackdrop: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    top: 0,
    backgroundColor: "rgba(31, 33, 29, 0.42)"
  },
  joinModalBackdropTapTarget: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    top: 0
  },
  joinModalButton: {
    flex: 1,
    minWidth: 128,
    paddingHorizontal: 12
  },
  joinModalSheet: {
    gap: 14,
    maxWidth: 420,
    width: "100%"
  },
  profileActions: {
    alignItems: "center",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 12,
    justifyContent: "center",
    width: "100%"
  },
  profileAvatar: {
    alignItems: "center",
    aspectRatio: 1,
    backgroundColor: appColors.accentSoft,
    borderColor: appColors.border,
    borderRadius: 16,
    borderWidth: 1,
    justifyContent: "center",
    width: 58
  },
  profileAvatarText: {
    color: appColors.accent,
    fontSize: 24,
    fontWeight: "700",
    lineHeight: 30
  },
  profileHeader: {
    alignItems: "center",
    gap: 12
  },
  profileHeaderCopy: {
    alignItems: "center",
    gap: 2,
    width: "100%"
  },
  screen: {
    alignItems: "center",
    flex: 1,
    justifyContent: "center",
    padding: 20
  },
  signupProfile: {
    alignItems: "center",
    gap: 10,
    width: "100%"
  },
  settingsCard: {
    alignItems: "center"
  },
  signInSeparator: {
    alignItems: "center",
    flexDirection: "row",
    gap: appSpacing.md,
    marginVertical: appSpacing.xs,
    width: "100%"
  },
  signInSeparatorLine: {
    backgroundColor: appColors.border,
    flex: 1,
    height: 1
  },
  signInSeparatorText: {
    color: appColors.muted,
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 1,
    lineHeight: 16
  }
});
