import React, { useState, useEffect } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";

import { apiClient } from "../../api/client";
import { useAuth } from "../../auth/AuthProvider";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { Chip } from "../../components/Chip";
import { ErrorState } from "../../components/ErrorState";
import { Field } from "../../components/Field";
import { Icon } from "../../components/Icon";
import "./AccountPage.css";

const profileEmojiOptions = ["🍳", "🥘", "🥗", "🍜", "🍕", "🥐", "🌶️", "🍰", "🍔", "🍣", "🍪"];

const accountUtilityLinks = [
  {
    description: "Daily list for groceries and staples",
    icon: "basket-outline",
    label: "Shopping list",
    to: "/shopping"
  },
  {
    description: "Family members and shared recipes",
    icon: "account-multiple-outline",
    label: "Household",
    to: "/household"
  },
  {
    description: "Plan details and upgrade options",
    icon: "star-circle-outline",
    label: "Plans",
    to: "/pricing"
  },
  {
    description: "Add LinkDish to your home screen",
    icon: "download-outline",
    label: "Install app",
    to: "/install"
  }
] as const;

const AccountUtilityLinks = () => (
  <Card variant="default" className="profile-card account-links-card">
    <h2 className="section-label">Account</h2>
    <nav className="account-utility-links" aria-label="Account links">
      {accountUtilityLinks.map((link) => (
        <Link className="account-utility-link" to={link.to} key={link.to}>
          <span className="account-utility-icon">
            <Icon name={link.icon} size={19} color="currentColor" />
          </span>
          <span className="account-utility-copy">
            <span className="account-utility-label">{link.label}</span>
            <span className="account-utility-description">{link.description}</span>
          </span>
          <Icon name="chevron-right" size={19} color="currentColor" />
        </Link>
      ))}
    </nav>
  </Card>
);

export const AccountPage: React.FC = () => {
  const {
    user,
    isAuthenticated,
    clerkEnabled,
    emailCodeEnabled,
    hasClerkPublishableKey,
    clerkReady,
    loading,
    requestLoginCode,
    verifyLoginCode,
    loginWithGoogle,
    logout,
    deleteAccount,
    refreshUser
  } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [loginState, setLoginState] = useState<
    "idle" | "sending_code" | "entering_code" | "verifying_code"
  >("idle");
  const [error, setError] = useState("");

  // Profile update states
  const [displayName, setDisplayName] = useState("");
  const [avatarEmoji, setAvatarEmoji] = useState("");
  const [profileMessage, setProfileMessage] = useState("");
  const [savingProfile, setSavingProfile] = useState(false);
  const [showCustomEmojiInput, setShowCustomEmojiInput] = useState(false);
  const [customEmoji, setCustomEmoji] = useState("");

  // Account deletion states
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteConfirmEmail, setDeleteConfirmEmail] = useState("");
  const [deleteError, setDeleteError] = useState("");
  const [deleting, setDeleting] = useState(false);

  const inviteIntent = searchParams.get("invite");
  const upgradeIntent = searchParams.get("upgrade");
  const postSignInDestination = inviteIntent
    ? `/household?invite=${encodeURIComponent(inviteIntent)}`
    : upgradeIntent === "plus" || upgradeIntent === "family"
      ? "/pricing"
      : null;

  useEffect(() => {
    if (user) {
      setDisplayName(user.displayName || "");
      setAvatarEmoji(user.avatarEmoji || "");
      setProfileMessage("");
    }
  }, [user]);

  useEffect(() => {
    if (isAuthenticated && postSignInDestination) {
      void navigate(postSignInDestination, { replace: true });
    }
  }, [isAuthenticated, navigate, postSignInDestination]);

  const handleRequestCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (!email.trim() || !email.includes("@")) {
      setError("Please enter a valid email address.");
      return;
    }

    setLoginState("sending_code");
    try {
      await requestLoginCode(email.trim());
      setLoginState("entering_code");
    } catch (err) {
      console.error(err);
      setError("Failed to send login code. Please try again.");
      setLoginState("idle");
    }
  };

  const handleVerifyCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (!code.trim() || !/^\d{6}$/.test(code.trim())) {
      setError("Please enter a 6-digit number code.");
      return;
    }

    setLoginState("verifying_code");
    try {
      await verifyLoginCode(email.trim(), code.trim());
      setLoginState("idle");
    } catch (err) {
      console.error(err);
      setError("Invalid or expired login code.");
      setLoginState("entering_code");
    }
  };

  const handleSaveProfile = async () => {
    setProfileMessage("");
    setSavingProfile(true);
    try {
      await apiClient.updateAccountProfile({
        displayName: displayName.trim() || null,
        avatarEmoji: avatarEmoji.trim() || null
      });
      await refreshUser();
      setProfileMessage("Profile saved.");
    } catch (err) {
      console.error(err);
      setProfileMessage("Failed to update profile.");
    } finally {
      setSavingProfile(false);
    }
  };

  const handleDeleteAccountSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setDeleteError("");

    if (deleteConfirmEmail.trim() !== user?.email) {
      setDeleteError("Email address does not match your current account email.");
      return;
    }

    setDeleting(true);
    try {
      await deleteAccount(deleteConfirmEmail.trim());
    } catch (err) {
      console.error(err);
      setDeleteError("Failed to delete account. Please try again.");
      setDeleting(false);
    }
  };

  const handleGoogleLogin = async () => {
    setError("");
    try {
      await loginWithGoogle(postSignInDestination ?? "/");
    } catch (err) {
      console.error("Google login error:", err);
      setError(err instanceof Error ? err.message : "Google sign-in is currently unavailable.");
    }
  };

  const isProfileDirty =
    Boolean(user) &&
    (displayName.trim() !== (user?.displayName || "") ||
      avatarEmoji.trim() !== (user?.avatarEmoji || ""));

  const profileAvatarPreview =
    avatarEmoji.trim() ||
    (user?.displayName ? user.displayName.substring(0, 2).toUpperCase() : "LD");

  const customEmojiSelected = Boolean(avatarEmoji) && !profileEmojiOptions.includes(avatarEmoji);
  const showGoogleSignIn = clerkEnabled;
  const canUseGoogleSignIn = clerkEnabled && hasClerkPublishableKey && clerkReady;

  if (loading) {
    return (
      <div className="account-page container page-enter">
        <p className="account-loading">Loading account status...</p>
      </div>
    );
  }

  return (
    <div className="account-page container page-enter">
      {isAuthenticated && user ? (
        <div className="account-profile-container animate-fade-in">
          {/* Card 1: Edit Profile */}
          <Card variant="default" className="profile-card edit-profile-card">
            <header className="profile-header">
              <div className="profile-avatar" aria-hidden="true">
                {profileAvatarPreview}
              </div>
              <div className="profile-details">
                <h1 className="profile-name">{user.displayName || user.email}</h1>
                <p className="profile-email">{user.email}</p>
              </div>
            </header>

            <div className="profile-form">
              <Field
                placeholder="Display name"
                value={displayName}
                onChange={(e) => {
                  setDisplayName(e.target.value);
                  setProfileMessage("");
                }}
                disabled={savingProfile}
                type="text"
                id="display-name-input"
              />

              <div className="emoji-picker-section">
                <span className="section-label">Choose Profile Emoji</span>
                <div className="emoji-grid">
                  {profileEmojiOptions.map((emoji) => {
                    const isSelected = avatarEmoji === emoji;
                    return (
                      <button
                        key={emoji}
                        type="button"
                        className={`emoji-option ${isSelected ? "selected" : ""}`}
                        disabled={savingProfile}
                        onClick={() => {
                          setAvatarEmoji(isSelected ? "" : emoji);
                          setProfileMessage("");
                        }}
                      >
                        {emoji}
                      </button>
                    );
                  })}
                  <button
                    type="button"
                    className={`emoji-option custom-option ${customEmojiSelected || showCustomEmojiInput ? "selected" : ""}`}
                    disabled={savingProfile}
                    onClick={() => {
                      setShowCustomEmojiInput(!showCustomEmojiInput);
                      setProfileMessage("");
                    }}
                  >
                    {customEmojiSelected ? avatarEmoji : "+"}
                  </button>
                </div>

                {showCustomEmojiInput && (
                  <div className="custom-emoji-input-wrapper">
                    <Field
                      placeholder="Paste single emoji"
                      value={customEmoji}
                      onChange={(e) => {
                        const input = e.target.value.trim();
                        if (input) {
                          setAvatarEmoji(input);
                          setCustomEmoji(input);
                          setShowCustomEmojiInput(false);
                          setProfileMessage("");
                        }
                      }}
                      maxLength={4}
                    />
                  </div>
                )}
              </div>

              <div className="profile-save-actions">
                <Button
                  onClick={handleSaveProfile}
                  disabled={savingProfile || !isProfileDirty}
                  loading={savingProfile}
                  fullWidth
                >
                  Save profile
                </Button>
                {profileMessage && <p className="profile-saved-message">{profileMessage}</p>}
              </div>
            </div>
          </Card>

          {/* Card 2: Account Actions & Plans */}
          <Card variant="default" className="profile-card plan-actions-card">
            <div className="profile-section">
              <h3 className="section-label">Billing Plan</h3>
              <div className="plan-badge-container">
                <Chip
                  variant={!user.billingPlan || user.billingPlan === "free" ? "default" : "accent"}
                  className="plan-chip"
                >
                  {user.billingPlan
                    ? user.billingPlan.charAt(0).toUpperCase() + user.billingPlan.slice(1)
                    : "Free"}
                </Chip>
                <p className="plan-description">
                  {user.billingPlan === "family" &&
                    "Family Plan: Unlimited saved recipes, household sync."}
                  {user.billingPlan === "plus" && "Plus Plan: Unlimited saved recipes."}
                  {(!user.billingPlan || user.billingPlan === "free") &&
                    "Free Plan: Save up to 15 recipes."}
                </p>
              </div>
            </div>

            <div className="account-signout-action">
              <Button variant="outline-danger" onClick={logout} fullWidth>
                <Icon name="logout" size={18} /> Sign out
              </Button>
            </div>
          </Card>

          <AccountUtilityLinks />

          {/* Card 3: Danger Zone */}
          {!showDeleteConfirm ? (
            <div className="danger-zone-trigger">
              <button className="text-danger-btn" onClick={() => setShowDeleteConfirm(true)}>
                Delete Account
              </button>
            </div>
          ) : (
            <Card variant="subtle" className="delete-confirm-card">
              <h3 className="delete-title">⚠️ Delete Account Permanently</h3>
              <p className="delete-warning">
                This removes your LinkDish account, household membership, and shared Family recipes
                you added. Saved recipes on this device remain local.
              </p>

              <form onSubmit={handleDeleteAccountSubmit} className="delete-form">
                <Field
                  placeholder="Confirm your email"
                  value={deleteConfirmEmail}
                  onChange={(e) => setDeleteConfirmEmail(e.target.value)}
                  error={deleteError}
                  disabled={deleting}
                  type="email"
                />

                <div className="delete-actions">
                  <Button
                    type="submit"
                    variant="outline-danger"
                    loading={deleting}
                    disabled={
                      deleting ||
                      deleteConfirmEmail.trim().toLowerCase() !== user.email.toLowerCase()
                    }
                  >
                    <Icon name="delete-outline" size={18} /> Delete account
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setShowDeleteConfirm(false);
                      setDeleteConfirmEmail("");
                      setDeleteError("");
                    }}
                    disabled={deleting}
                  >
                    Cancel
                  </Button>
                </div>
              </form>
            </Card>
          )}
        </div>
      ) : (
        <div className="account-login-container animate-fade-in">
          <Card variant="default" className="login-card">
            <h1 className="login-title">Sign In to LinkDish</h1>
            <p className="login-subtitle">
              Buy or restore a plan and share recipes with your Family household.
            </p>

            {error && <ErrorState message={error} />}

            {emailCodeEnabled &&
              (loginState === "idle" || loginState === "sending_code" ? (
                <form onSubmit={handleRequestCode} className="login-form">
                  <Field
                    placeholder="Email address"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    disabled={loginState === "sending_code"}
                    type="email"
                    required
                  />
                  <Button type="submit" loading={loginState === "sending_code"} fullWidth>
                    Email sign-in code
                  </Button>
                </form>
              ) : (
                <form onSubmit={handleVerifyCode} className="login-form">
                  <p className="login-code-sent-msg">
                    We sent a 6-digit verification code to <strong>{email}</strong>.
                  </p>
                  <Field
                    placeholder="6-digit code"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    disabled={loginState === "verifying_code"}
                    type="text"
                    maxLength={6}
                    pattern="\d{6}"
                    required
                    autoFocus
                  />
                  <div className="login-actions-group">
                    <Button type="submit" loading={loginState === "verifying_code"} fullWidth>
                      Verify code
                    </Button>
                    <Button variant="ghost" onClick={() => setLoginState("idle")} fullWidth>
                      Back
                    </Button>
                  </div>
                </form>
              ))}

            {showGoogleSignIn && emailCodeEnabled && (
              <div className="sso-divider-container">
                <span className="sso-divider-line"></span>
                <span className="sso-divider-text">or</span>
                <span className="sso-divider-line"></span>
              </div>
            )}

            {showGoogleSignIn && (
              <Button
                variant="outline"
                onClick={handleGoogleLogin}
                fullWidth
                disabled={!canUseGoogleSignIn}
              >
                <Icon name="google" size={18} /> Continue with Google
              </Button>
            )}

            {showGoogleSignIn && !canUseGoogleSignIn && (
              <p className="sso-config-message" role="status">
                Google sign-in is temporarily unavailable. Use email sign-in for now.
              </p>
            )}
          </Card>
          <AccountUtilityLinks />
        </div>
      )}
    </div>
  );
};
