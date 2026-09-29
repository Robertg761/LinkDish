import React, { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";

import { apiClient } from "../../api/client";
import { getFriendlyErrorMessage } from "../../api/error-message";
import { isExtractorApiError } from "../../api/errors";
import { getAccountScope, useIsCurrentAccount } from "../../auth/account-scope";
import { useAuth } from "../../auth/AuthProvider";
import { Badge } from "../../components/Badge";
import { Button, ButtonLink } from "../../components/Button";
import { Card } from "../../components/Card";
import { Field } from "../../components/Field";
import { Icon } from "../../components/Icon";
import { PageHeader } from "../../components/PageHeader";
import { ProgressBar } from "../../components/ProgressBar";
import { Sheet } from "../../components/Sheet";
import { Skeleton } from "../../components/Skeleton";
import { useToast } from "../../components/Toast";
import { useSavedRecipes } from "../../data/library-store";
import { useDocumentTitle } from "../../lib/use-document-title";
import { useMediaQuery } from "../../lib/use-media-query";
import { getWebBillingTier, webBillingPlans, type WebBillingTier } from "../billing/web-billing";
import { useImportUsageState } from "../extract/use-import-usage";
import { getInitials } from "../household/use-household-summary";
import { describeFreeQuota } from "../library/components/free-quota";
import { countCookbook } from "../library/components/library-model";
import { isPaidPlan, planContent } from "../pricing/plans-content";

import type { IconName } from "../../components/Icon";
import type { AccountUser } from "@linkdish/api-contracts";

import "./AccountPage.css";

const PROFILE_EMOJI_OPTIONS = ["🍳", "🥘", "🥗", "🍜", "🍕", "🥐", "🌶️", "🍰", "🍔", "🍣", "🍪"];

interface QuickLink {
  to: string;
  label: string;
  description: string;
  icon: IconName;
}

/** Places that aren't already a tab: Shopping lives in the tab bar, so it isn't repeated here. */
const buildQuickLinks = (touch: boolean): QuickLink[] => [
  { description: "Theme, units, cooking", icon: "settings", label: "Settings", to: "/settings" },
  { description: "Share with family", icon: "users", label: "Household", to: "/household" },
  {
    description: "Back up or bring recipes over",
    icon: "download",
    label: "Your data",
    to: "/settings#your-data"
  },
  {
    description: touch ? "Add to your home screen" : "Home screen and bookmarklet",
    icon: "smartphone-download",
    label: "Install app",
    to: "/install"
  },
  { description: "Questions and ideas", icon: "help-circle", label: "Support", to: "/support" },
  { description: "What we store and why", icon: "shield-check", label: "Privacy", to: "/privacy" }
];

const SIGN_IN_BENEFITS: ReadonlyArray<{ icon: IconName; title: string; body: string }> = [
  {
    body: "Plus and Family follow your account, on the web and in the LinkDish apps.",
    icon: "crown",
    title: "Keep your plan"
  },
  {
    body: "Join a household to share recipes and one shopping list that stays in sync.",
    icon: "users",
    title: "Cook together"
  },
  {
    body: "Your cookbook stays on this device unless you share it with your household.",
    icon: "shield-check",
    title: "Private by default"
  }
];

/** Where to send someone once they're signed in, when they came here with an intent. */
export const getPostSignInDestination = (params: URLSearchParams): string | null => {
  const invite = params.get("invite")?.trim();

  if (invite) {
    return `/household?invite=${encodeURIComponent(invite)}`;
  }

  const upgrade = params.get("upgrade");

  if (isPaidPlan(upgrade)) {
    const period = params.get("period");
    return `/pricing?upgrade=${upgrade}${period === "monthly" ? "&period=monthly" : ""}`;
  }

  return null;
};

const getDisplayName = (user: AccountUser): string =>
  user.displayName?.trim() || user.email.split("@")[0] || user.email;

const QuickLinks: React.FC = () => {
  const touch = useMediaQuery("(pointer: coarse)");

  return (
    <nav aria-label="Account links" className="account-links">
      {buildQuickLinks(touch).map((link) => (
        <Link className="account-link" key={link.to} to={link.to}>
          <span className="account-link-icon">
            <Icon name={link.icon} size={20} />
          </span>
          <span className="account-link-copy">
            <span className="account-link-label">{link.label}</span>
            <span className="account-link-description">{link.description}</span>
          </span>
          <Icon className="account-link-chevron" name="chevron-right" size={18} />
        </Link>
      ))}
    </nav>
  );
};

type LoginStep = "email" | "sending" | "code" | "verifying";

const SignInView: React.FC<{ destination: string | null }> = ({ destination }) => {
  const {
    clerkEnabled,
    clerkReady,
    emailCodeEnabled,
    hasClerkPublishableKey,
    loginWithGoogle,
    requestLoginCode,
    verifyLoginCode
  } = useAuth();
  const [searchParams] = useSearchParams();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<LoginStep>("email");
  const [error, setError] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const showGoogle = clerkEnabled;
  const canUseGoogle = clerkEnabled && hasClerkPublishableKey && clerkReady;
  const upgradeIntent = searchParams.get("upgrade");
  const intentNote = searchParams.get("invite")
    ? "Sign in with the email your invite was sent to, and we'll take you straight to your household."
    : isPaidPlan(upgradeIntent)
      ? `Sign in to continue to ${planContent[upgradeIntent].name}. We'll bring you straight back to it.`
      : null;

  const requestCode = async (event: React.FormEvent) => {
    event.preventDefault();
    setError("");

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email.trim())) {
      setFieldError("Enter your email address, like name@example.com.");
      return;
    }

    setFieldError(null);
    setStep("sending");

    try {
      await requestLoginCode(email.trim());
      setStep("code");
    } catch (failure) {
      setError(getFriendlyErrorMessage(failure, "auth"));
      setStep("email");
    }
  };

  const verifyCode = async (event: React.FormEvent) => {
    event.preventDefault();
    setError("");

    if (!/^\d{6}$/u.test(code.trim())) {
      setFieldError("Enter the 6-digit code from the email.");
      return;
    }

    setFieldError(null);
    setStep("verifying");

    try {
      await verifyLoginCode(email.trim(), code.trim());
    } catch (failure) {
      setError(
        isExtractorApiError(failure) && [400, 401, 403].includes(failure.statusCode)
          ? "That code didn't work. Check the newest email from LinkDish, or send a new code."
          : getFriendlyErrorMessage(failure, "auth")
      );
      setStep("code");
    }
  };

  const signInWithGoogle = async () => {
    setError("");

    try {
      await loginWithGoogle(destination ?? "/");
    } catch (failure) {
      setError(getFriendlyErrorMessage(failure, "auth"));
    }
  };

  const onCodeStep = step === "code" || step === "verifying";

  return (
    <div className="account-signed-out">
      <PageHeader
        accent="LinkDish"
        eyebrow="Account"
        subtitle="Keep your plan with you and cook together with your household."
        title="Sign in to"
      />

      <div className="account-signin-layout">
        <Card className="account-signin-card" padding="lg" variant="raised">
          {intentNote ? (
            <p className="account-intent-note">
              <Icon name="info" size={18} />
              <span>{intentNote}</span>
            </p>
          ) : null}

          {error ? (
            <p className="account-form-error" role="alert">
              <Icon name="alert-circle" size={18} />
              <span>{error}</span>
            </p>
          ) : null}

          {showGoogle && !onCodeStep ? (
            <>
              <Button
                disabled={!canUseGoogle}
                fullWidth
                icon="google"
                onClick={() => void signInWithGoogle()}
                size="lg"
                variant="secondary"
              >
                Continue with Google
              </Button>
              {!canUseGoogle ? (
                <p className="account-signin-hint" role="status">
                  Google sign-in is temporarily unavailable. Use email sign-in for now.
                </p>
              ) : null}
            </>
          ) : null}

          {showGoogle && emailCodeEnabled && !onCodeStep ? (
            <div aria-hidden="true" className="account-divider">
              <span>or</span>
            </div>
          ) : null}

          {emailCodeEnabled && !onCodeStep ? (
            <form className="account-signin-form" noValidate onSubmit={requestCode}>
              <Field
                autoComplete="email"
                disabled={step === "sending"}
                error={fieldError ?? undefined}
                inputMode="email"
                label="Email address"
                leadingIcon="mail"
                onChange={(event) => {
                  setEmail(event.target.value);
                  setFieldError(null);
                }}
                placeholder="name@example.com"
                type="email"
                value={email}
              />
              <Button fullWidth loading={step === "sending"} size="lg" type="submit">
                Email me a sign-in code
              </Button>
            </form>
          ) : null}

          {onCodeStep ? (
            <form className="account-signin-form" noValidate onSubmit={verifyCode}>
              <div className="account-code-intro">
                <h2>Check your email</h2>
                <p>
                  We sent a 6-digit code to <strong>{email.trim()}</strong>. It can take a minute to
                  arrive.
                </p>
              </div>
              <Field
                autoComplete="one-time-code"
                autoFocus
                className="account-code-field"
                disabled={step === "verifying"}
                error={fieldError ?? undefined}
                inputMode="numeric"
                label="6-digit code"
                maxLength={6}
                onChange={(event) => {
                  setCode(event.target.value.replace(/\D/gu, ""));
                  setFieldError(null);
                }}
                pattern="\d{6}"
                placeholder="123456"
                value={code}
              />
              <Button fullWidth loading={step === "verifying"} size="lg" type="submit">
                Verify and sign in
              </Button>
              <Button
                fullWidth
                onClick={() => {
                  setStep("email");
                  setCode("");
                  setError("");
                  setFieldError(null);
                }}
                variant="ghost"
              >
                Use a different email
              </Button>
            </form>
          ) : null}

          {!emailCodeEnabled && !showGoogle ? (
            <p className="account-signin-hint">
              Sign-in is taking a short break. Please try again in a little while.
            </p>
          ) : null}

          <p className="account-signin-fineprint">
            New here? The same steps create your free account.{" "}
            <Link to="/privacy">How we handle your data</Link>
          </p>
        </Card>

        <ul aria-label="Why sign in" className="account-benefits">
          {SIGN_IN_BENEFITS.map((benefit) => (
            <li className="account-benefit" key={benefit.title}>
              <span className="account-benefit-icon">
                <Icon name={benefit.icon} size={20} />
              </span>
              <span className="account-benefit-copy">
                <strong>{benefit.title}</strong>
                <span>{benefit.body}</span>
              </span>
            </li>
          ))}
        </ul>
      </div>

      <section aria-labelledby="account-more-title" className="account-section">
        <h2 className="account-section-title" id="account-more-title">
          More
        </h2>
        <QuickLinks />
      </section>
    </div>
  );
};

interface ProfileSheetProps {
  user: AccountUser;
  open: boolean;
  onClose: () => void;
  /** Whether an account is still the one signed in (checked when a save answers). */
  isCurrentAccount: (account: string | null) => boolean;
}

const ProfileSheet: React.FC<ProfileSheetProps> = ({ user, open, onClose, isCurrentAccount }) => {
  const { refreshUser } = useAuth();
  const { showToast } = useToast();
  const [displayName, setDisplayName] = useState(user.displayName ?? "");
  const [avatarEmoji, setAvatarEmoji] = useState(user.avatarEmoji ?? "");
  const [customEmoji, setCustomEmoji] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (open) {
      setDisplayName(user.displayName ?? "");
      setAvatarEmoji(user.avatarEmoji ?? "");
      setCustomEmoji("");
      setError("");
    }
  }, [open, user.avatarEmoji, user.displayName]);

  const dirty =
    displayName.trim() !== (user.displayName ?? "") ||
    avatarEmoji.trim() !== (user.avatarEmoji ?? "");
  const customSelected = Boolean(avatarEmoji) && !PROFILE_EMOJI_OPTIONS.includes(avatarEmoji);

  const save = async () => {
    const savedFor = user.id;
    setSaving(true);
    setError("");

    try {
      await apiClient.updateAccountProfile({
        avatarEmoji: avatarEmoji.trim() || null,
        displayName: displayName.trim() || null
      });

      // Another account signed in meanwhile: the saved profile (and its toast) was the last one's.
      if (!isCurrentAccount(savedFor)) {
        return;
      }

      await refreshUser();
      showToast({ message: "Profile saved", tone: "success" });
      onClose();
    } catch (failure) {
      if (isCurrentAccount(savedFor)) {
        setError(getFriendlyErrorMessage(failure, "save"));
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet
      description="Your household sees this name and emoji next to what you share."
      dismissible={!saving}
      footer={
        <>
          <Button disabled={saving} onClick={onClose} variant="ghost">
            Cancel
          </Button>
          <Button disabled={!dirty} loading={saving} onClick={() => void save()}>
            Save profile
          </Button>
        </>
      }
      onClose={onClose}
      open={open}
      size="sm"
      title="Edit profile"
    >
      {error ? (
        <p className="account-form-error" role="alert">
          <Icon name="alert-circle" size={18} />
          <span>{error}</span>
        </p>
      ) : null}
      <Field
        autoComplete="nickname"
        disabled={saving}
        label="Display name"
        maxLength={60}
        onChange={(event) => setDisplayName(event.target.value)}
        placeholder={user.email.split("@")[0]}
        value={displayName}
      />
      <fieldset className="account-emoji-fieldset">
        <legend className="field-label">Profile emoji</legend>
        <div className="account-emoji-grid">
          {PROFILE_EMOJI_OPTIONS.map((emoji) => {
            const selected = avatarEmoji === emoji;

            return (
              <button
                aria-label={`Use ${emoji}`}
                aria-pressed={selected}
                className={`account-emoji${selected ? " is-selected" : ""}`}
                disabled={saving}
                key={emoji}
                onClick={() => setAvatarEmoji(selected ? "" : emoji)}
                type="button"
              >
                {emoji}
              </button>
            );
          })}
          {customSelected ? (
            <button
              aria-label={`Use ${avatarEmoji}`}
              aria-pressed
              className="account-emoji is-selected"
              onClick={() => setAvatarEmoji("")}
              type="button"
            >
              {avatarEmoji}
            </button>
          ) : null}
        </div>
        <Field
          disabled={saving}
          hint="Or paste any single emoji."
          label="Custom emoji"
          maxLength={8}
          onChange={(event) => {
            const value = event.target.value.trim();
            setCustomEmoji(value);

            if (value) {
              setAvatarEmoji(value);
            }
          }}
          value={customEmoji}
        />
      </fieldset>
    </Sheet>
  );
};

interface UsageMeterProps {
  label: string;
  /** Null while the count is still loading: the meter holds its place with an empty bar. */
  used: number | null;
  limit: number;
  tone: "primary" | "butter" | "tomato";
  note?: string | null | undefined;
}

/** One meter shape for every plan: what's used, filling toward the limit, coloured by urgency. */
const UsageMeter: React.FC<UsageMeterProps> = ({ label, used, limit, tone, note }) => (
  <div aria-busy={used === null ? true : undefined} className="account-plan-meter">
    <div className="account-plan-meter-row">
      <span>{label}</span>
      {used === null ? (
        <Skeleton height={16} width={48} />
      ) : (
        <strong className="num">
          {used} of {limit}
        </strong>
      )}
    </div>
    <ProgressBar
      label={label}
      max={limit}
      tone={tone}
      value={used ?? 0}
      valueText={used === null ? "Loading" : `${used} of ${limit} used`}
    />
    {note ? <p className="account-plan-meter-note">{note}</p> : null}
  </div>
);

const usageTone = (used: number, limit: number): UsageMeterProps["tone"] =>
  limit > 0 && used >= limit ? "tomato" : limit > 0 && used / limit >= 0.75 ? "butter" : "primary";

const formatResetDate = (value: string | null): string | null => {
  const time = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(time)
    ? new Date(time).toLocaleDateString(undefined, { day: "numeric", month: "short" })
    : null;
};

const PlanCardSection: React.FC<{ tier: WebBillingTier }> = ({ tier }) => {
  const { recipes, status } = useSavedRecipes();
  const counts = useMemo(() => countCookbook(recipes), [recipes]);
  const limit = webBillingPlans.free.limits.savedRecipes;
  const quota = typeof limit === "number" ? describeFreeQuota(counts, limit) : null;
  const { pending: importsPending, usage: importUsage } = useImportUsageState(null, 0);
  const planImports = webBillingPlans[tier].limits.monthlyImports;
  const importsUsed = importUsage ? Math.max(0, importUsage.limit - importUsage.remaining) : 0;
  const resetsOn = formatResetDate(importUsage?.resetsAt ?? null);
  const copy = planContent[tier];

  return (
    <Card className="account-plan" variant="default">
      <div className="account-plan-head">
        <div>
          <p className="account-plan-eyebrow">Plan &amp; usage</p>
          <h2 className="account-plan-name">
            LinkDish {copy.name}
            {tier !== "free" ? (
              <Badge appearance="solid" icon="check" tone="primary">
                Active
              </Badge>
            ) : null}
          </h2>
          <p className="account-plan-tagline">{copy.tagline}</p>
        </div>
      </div>

      {/* The meters hold their place while the counts load, so the card never jumps. */}
      {tier === "free" && quota && status === "loading" ? (
        <UsageMeter label="Saved recipes" limit={quota.limit} tone="primary" used={null} />
      ) : null}

      {tier === "free" && quota && status === "ready" ? (
        <UsageMeter
          label="Saved recipes"
          limit={quota.limit}
          note={[
            quota.state === "over"
              ? `${quota.statusText}. They all stay; new saves need Plus.`
              : quota.state === "roomy"
                ? null
                : `${quota.statusText}.`,
            quota.starterNote
          ]
            .filter(Boolean)
            .join(" ")}
          tone={quota.tone}
          used={quota.saved}
        />
      ) : null}

      {importsPending && planImports > 0 ? (
        <UsageMeter
          label={tier === "free" ? "Free imports used" : "Imports used this month"}
          limit={planImports}
          tone="primary"
          used={null}
        />
      ) : null}

      {importUsage && importUsage.limit > 0 ? (
        <UsageMeter
          label={importUsage.monthly ? "Imports used this month" : "Free imports used"}
          limit={importUsage.limit}
          note={importUsage.monthly && resetsOn ? `Resets ${resetsOn}.` : null}
          tone={usageTone(importsUsed, importUsage.limit)}
          used={importsUsed}
        />
      ) : null}

      <ul className="account-plan-features">
        {copy.highlights.map((feature) => (
          <li key={`${feature.emphasis ?? ""}${feature.text}`}>
            <Icon name="check" size={16} strokeWidth={2.6} />
            <span>
              {feature.emphasis ? <strong>{feature.emphasis}</strong> : null}
              {feature.text}
            </span>
          </li>
        ))}
      </ul>

      <div className="account-plan-actions">
        {tier === "free" ? (
          <>
            <ButtonLink icon="sparkles" to="/pricing?upgrade=plus">
              Upgrade to Plus
            </ButtonLink>
            <ButtonLink to="/pricing" variant="ghost">
              Compare plans
            </ButtonLink>
          </>
        ) : tier === "family" ? (
          <>
            <ButtonLink icon="users" to="/household">
              Manage household
            </ButtonLink>
            <ButtonLink to="/pricing" variant="ghost">
              Plan &amp; billing
            </ButtonLink>
          </>
        ) : (
          <>
            <ButtonLink to="/pricing" variant="secondary">
              Plan &amp; billing
            </ButtonLink>
            <ButtonLink to="/pricing?upgrade=family" variant="ghost">
              Share with Family
            </ButtonLink>
          </>
        )}
      </div>
    </Card>
  );
};

const DeleteAccount: React.FC<{ user: AccountUser }> = ({ user }) => {
  const { deleteAccount } = useAuth();
  const [open, setOpen] = useState(false);
  const [confirmEmail, setConfirmEmail] = useState("");
  const [error, setError] = useState("");
  const [deleting, setDeleting] = useState(false);
  const matches = confirmEmail.trim().toLowerCase() === user.email.toLowerCase();

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError("");

    if (!matches) {
      setError("Email address does not match your current account email.");
      return;
    }

    setDeleting(true);

    try {
      await deleteAccount(confirmEmail.trim());
    } catch (failure) {
      setError(getFriendlyErrorMessage(failure, "generic"));
      setDeleting(false);
    }
  };

  if (!open) {
    return (
      <div className="account-danger-trigger">
        <button className="account-danger-link" onClick={() => setOpen(true)} type="button">
          Delete account
        </button>
      </div>
    );
  }

  return (
    <section aria-labelledby="account-delete-title" className="account-danger">
      <div className="account-danger-head">
        <Icon name="alert-triangle" size={20} />
        <h2 id="account-delete-title">Delete your account?</h2>
      </div>
      <ul className="account-danger-consequences">
        <li>Your LinkDish account and sign-in are removed for good.</li>
        <li>
          You leave your household, and recipes you shared there are removed. If you own the
          household, it closes for everyone.
        </li>
        <li>Recipes saved in this browser stay on this device.</li>
        <li>
          Deleting your account doesn&apos;t cancel a subscription. Cancel it first from{" "}
          <Link to="/pricing">Plans</Link> or the store you subscribed through.
        </li>
      </ul>
      <form className="account-danger-form" noValidate onSubmit={submit}>
        <Field
          aria-label="Confirm your email"
          autoComplete="off"
          disabled={deleting}
          error={error || undefined}
          hint={`Type ${user.email} to confirm.`}
          label="Confirm your email"
          onChange={(event) => setConfirmEmail(event.target.value)}
          placeholder={user.email}
          type="email"
          value={confirmEmail}
        />
        <div className="account-danger-actions">
          <Button
            disabled={deleting}
            onClick={() => {
              setOpen(false);
              setConfirmEmail("");
              setError("");
            }}
            variant="ghost"
          >
            Keep my account
          </Button>
          <Button
            disabled={!matches}
            icon="trash"
            loading={deleting}
            type="submit"
            variant="danger"
          >
            Delete account
          </Button>
        </div>
      </form>
    </section>
  );
};

export const AccountPage: React.FC = () => {
  const { user, isAuthenticated, loading, logout } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const isCurrentAccount = useIsCurrentAccount(getAccountScope(isAuthenticated, user));
  /** The account the profile editor was opened for: it stays closed for any other. */
  const [profileOpenFor, setProfileOpenFor] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const destination = getPostSignInDestination(searchParams);
  useDocumentTitle(isAuthenticated ? "You" : "Sign in");

  useEffect(() => {
    if (isAuthenticated && destination) {
      void navigate(destination, { replace: true });
    }
  }, [destination, isAuthenticated, navigate]);

  if (loading) {
    return (
      <div className="account-page container page-enter">
        <div aria-label="Loading your account" className="account-skeleton" role="status">
          <Skeleton height={72} shape="circle" width={72} />
          <Skeleton height={28} width="50%" />
          <Skeleton height={160} radius={20} width="100%" />
        </div>
      </div>
    );
  }

  if (!isAuthenticated || !user) {
    return (
      <div className="account-page container page-enter">
        <SignInView destination={destination} />
      </div>
    );
  }

  const tier = getWebBillingTier(user);
  const name = getDisplayName(user);
  const avatar = user.avatarEmoji?.trim();

  return (
    <div className="account-page container page-enter">
      <header className="account-profile">
        <span aria-hidden="true" className={`account-avatar${avatar ? " has-emoji" : ""}`}>
          {avatar || getInitials(name)}
        </span>
        <div className="account-profile-copy">
          <p className="account-profile-eyebrow">Signed in</p>
          <h1 className="account-profile-name">{name}</h1>
          <p className="account-profile-email">{user.email}</p>
        </div>
        <Button
          aria-label="Edit profile"
          className="account-profile-edit"
          icon="pencil"
          onClick={() => setProfileOpenFor(user.id)}
          size="sm"
          variant="secondary"
        >
          Edit
        </Button>
      </header>

      <PlanCardSection tier={tier} />

      <section aria-labelledby="account-more-title" className="account-section">
        <h2 className="account-section-title" id="account-more-title">
          Everything else
        </h2>
        <QuickLinks />
      </section>

      <div className="account-signout">
        <Button
          fullWidth
          icon="log-out"
          loading={signingOut}
          onClick={() => {
            setSigningOut(true);
            void logout().finally(() => setSigningOut(false));
          }}
          variant="secondary"
        >
          Sign out
        </Button>
      </div>

      {/* Keyed by account: a draft or confirmation typed for one never carries to the next. */}
      <DeleteAccount key={`delete:${user.id}`} user={user} />

      <ProfileSheet
        isCurrentAccount={isCurrentAccount}
        key={`profile:${user.id}`}
        onClose={() => setProfileOpenFor(null)}
        open={profileOpenFor === user.id}
        user={user}
      />
    </div>
  );
};
