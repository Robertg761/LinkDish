import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";

import { trackWebEvent } from "../../analytics/client";
import { apiClient } from "../../api/client";
import { getFriendlyErrorMessage } from "../../api/error-message";
import { asAccount, isAccountChangedError } from "../../api/request-binding";
import { getAccountScope, useIsCurrentAccount } from "../../auth/account-scope";
import { useAuth } from "../../auth/AuthProvider";
import { Badge } from "../../components/Badge";
import { Button, ButtonLink } from "../../components/Button";
import { Card } from "../../components/Card";
import { ConfirmationDialog } from "../../components/ConfirmationDialog";
import { ErrorState } from "../../components/ErrorState";
import { Field } from "../../components/Field";
import { Icon } from "../../components/Icon";
import { PageHeader } from "../../components/PageHeader";
import { Skeleton } from "../../components/Skeleton";
import { useToast } from "../../components/Toast";
import { useDocumentTitle } from "../../lib/use-document-title";
import { getWebBillingTier } from "../billing/web-billing";
import { useUpgradeSheet } from "../upgrade/UpgradeSheet";

import { FamilyExplainer } from "./FamilyExplainer";
import {
  InviteShareActions,
  JoinHouseholdForm,
  MemberRow,
  PendingInviteRow
} from "./HouseholdParts";
import { getRememberedInviteCodes, parseInviteInput, rememberInviteShare } from "./invite-links";
import { getHouseholdOwner, getMemberDisplayName } from "./use-household-summary";

import type {
  HouseholdDetails,
  HouseholdInviteShare,
  HouseholdMember
} from "@linkdish/api-contracts";

import "./HouseholdPage.css";

type LoadState = "loading" | "ready" | "error";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

interface HouseholdViewProps {
  /** The account this view belongs to (null signed out); it never changes for a view. */
  account: string | null;
  isCurrentAccount: (account: string | null) => boolean;
}

export const HouseholdPage: React.FC = () => {
  useDocumentTitle("Household");
  const { isAuthenticated, user } = useAuth();
  const account = getAccountScope(isAuthenticated, user);
  const isCurrentAccount = useIsCurrentAccount(account);

  // One view per account: when another account signs in (or out) directly, the last one's
  // household, members, invites, owner controls, dialogs and busy actions go with its view, even
  // for the first render, and what its requests answer later lands nowhere.
  return (
    <HouseholdView
      account={account}
      isCurrentAccount={isCurrentAccount}
      key={account === null ? "signed-out" : `account:${account}`}
    />
  );
};

const HouseholdView: React.FC<HouseholdViewProps> = ({ account, isCurrentAccount }) => {
  const { credentialsKey, isAuthenticated, user, refreshUser } = useAuth();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { requestUpgradeSheet } = useUpgradeSheet();
  const { showToast } = useToast();
  const inviteFromUrl = parseInviteInput(searchParams.get("invite") ?? "");

  const [household, setHousehold] = useState<HouseholdDetails | null>(null);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [loadError, setLoadError] = useState("");
  const [actionError, setActionError] = useState("");
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteEmailError, setInviteEmailError] = useState<string | null>(null);
  const [lastInvite, setLastInvite] = useState<HouseholdInviteShare | null>(null);
  const [inviteToCancel, setInviteToCancel] = useState<{ email: string; id: string } | null>(null);
  const [memberToRemove, setMemberToRemove] = useState<HouseholdMember | null>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);
  /** Bumped by every load and every action's answer, so only the newest one lands. */
  const answerRef = useRef(0);
  /** An answer (a load's or an action's) is on the page: asking again keeps it meanwhile. */
  const shownRef = useRef(false);

  const plan = getWebBillingTier(user);
  const isOwner = household?.role === "owner";

  const members = useMemo(() => {
    if (!household) {
      return [];
    }

    // Owner first, then you, then everyone else in the order they joined.
    return [...household.members].sort((left, right) => {
      const rank = (member: HouseholdMember) =>
        member.role === "owner" ? 0 : member.userId === user?.id ? 1 : 2;
      return rank(left) - rank(right) || left.joinedAt.localeCompare(right.joinedAt);
    });
  }, [household, user?.id]);

  const rememberedCodes = useMemo(
    () => (household && isOwner ? getRememberedInviteCodes(household.invites) : {}),
    [household, isOwner]
  );

  const loadHousehold = useCallback(async () => {
    const load = ++answerRef.current;
    /** A newer load or action answered since, or another account signed in: drop this one. */
    const stale = () => load !== answerRef.current || !isCurrentAccount(account);
    // Asking again once this account's page is shown (its credentials changed) keeps the page,
    // and what's typed into it, until the answer lands: only a first load (or a retry after
    // an error) shows the skeleton.
    if (!shownRef.current) {
      setLoadState("loading");
      setLoadError("");
    }

    try {
      const response = await asAccount(account, () => apiClient.getHousehold());

      if (stale()) {
        return;
      }

      shownRef.current = true;
      setHousehold(response.household);
      setLoadState("ready");
    } catch (error) {
      // The page already shows this account's answer: keep it rather than an error in its place.
      // Not sent (another account signed in first) is no error of this account's either.
      if (stale() || shownRef.current || isAccountChangedError(error)) {
        return;
      }

      setLoadError(getFriendlyErrorMessage(error, "household"));
      setLoadState("error");
    }
  }, [account, isCurrentAccount]);

  // Keyed on the credentials (which include the account): it waits while a signed-in session's
  // credentials can't be read yet instead of asking without them, and asks again when they change.
  useEffect(() => {
    if (account === null || credentialsKey === null) {
      return;
    }

    void loadHousehold();
  }, [account, credentialsKey, loadHousehold]);

  useEffect(() => {
    if (isAuthenticated && loadState === "ready") {
      trackWebEvent({
        eventName: "web_household_viewed",
        routeOrScreen: "/household",
        properties: { has_household: household !== null, role: household?.role ?? "none" }
      });
    }
    // Deliberately once per load, not on every household update.
  }, [isAuthenticated, loadState]);

  const runAction = async (
    actionName: string,
    action: () => Promise<HouseholdDetails | null>,
    options: { refreshAccount?: boolean; success?: string } = {}
  ): Promise<boolean> => {
    setBusyAction(actionName);
    setActionError("");

    try {
      // Sent only as this account: if Clerk switches to another before the request goes out, it
      // must not join, leave or change that account's household.
      const next = await asAccount(account, action);

      // Another account signed in meanwhile: the answer (and its toast) was for the last one.
      if (!isCurrentAccount(account)) {
        return false;
      }

      // Newer than any load still out, which is dropped when it answers.
      answerRef.current += 1;
      shownRef.current = true;
      setHousehold(next);
      setLoadState("ready");

      if (options.refreshAccount) {
        await refreshUser();
      }

      if (options.success) {
        showToast({ message: options.success, tone: "success" });
      }

      return true;
    } catch (error) {
      if (isCurrentAccount(account)) {
        setActionError(getFriendlyErrorMessage(error, "household"));
      }

      return false;
    } finally {
      setBusyAction(null);
    }
  };

  const startHousehold = () => {
    if (plan !== "family") {
      // Creating a household needs Family; show the upsell instead of a failed request.
      if (!requestUpgradeSheet("family_share_no_plan")) {
        void navigate("/pricing?upgrade=family");
      }
      return;
    }

    void runAction("create", async () => (await apiClient.createHousehold()).household, {
      success: "Your household is ready. Invite someone to join."
    });
  };

  const sendInvite = (event: React.FormEvent) => {
    event.preventDefault();
    const email = inviteEmail.trim();

    if (!EMAIL_PATTERN.test(email)) {
      setInviteEmailError("Enter the email address they use for LinkDish.");
      return;
    }

    setInviteEmailError(null);
    void runAction(
      "invite",
      async () => {
        const response = await apiClient.createHouseholdInvite({ email });
        rememberInviteShare(response.invite);
        setLastInvite(response.invite);
        setInviteEmail("");
        trackWebEvent({
          eventName: "web_household_invite_created",
          routeOrScreen: "/household",
          properties: {}
        });
        return response.household;
      },
      { success: `Invite sent to ${email}` }
    );
  };

  const joinHousehold = (inviteCode: string) => {
    void runAction(
      "join",
      async () => (await apiClient.acceptHouseholdInvite({ inviteCode })).household,
      { refreshAccount: true, success: "Welcome to the household!" }
    ).then((joined) => {
      if (joined && searchParams.has("invite")) {
        void navigate("/household", { replace: true });
      }
    });
  };

  const cancelInvite = async (inviteId: string) => {
    await runAction(`cancel-${inviteId}`, async () => {
      const response = await apiClient.cancelHouseholdInvite({ inviteId });
      setLastInvite((invite) => (invite?.id === inviteId ? null : invite));
      return response.household;
    });
    setInviteToCancel(null);
  };

  const removeMember = async (member: HouseholdMember) => {
    await runAction(
      `remove-${member.userId}`,
      async () => (await apiClient.removeHouseholdMember({ userId: member.userId })).household,
      { success: `${getMemberDisplayName(member)} was removed` }
    );
    setMemberToRemove(null);
  };

  const leaveHousehold = async () => {
    const left = await runAction(
      "leave",
      async () => (await apiClient.leaveHousehold()).household,
      { refreshAccount: true, success: "You left the household" }
    );

    if (left) {
      setLastInvite(null);
    }

    setConfirmLeave(false);
  };

  const header = (
    <PageHeader
      accent={household ? "household" : "shop as one."}
      eyebrow={household ? "Family" : "LinkDish Family"}
      subtitle={
        household
          ? "One cookbook and one shopping list for everyone in it."
          : "One cookbook and one shopping list, shared by up to 6 people."
      }
      title={household ? "Your" : "Cook together,"}
    />
  );

  if (!isAuthenticated) {
    const signInPath = `/account${inviteFromUrl ? `?invite=${encodeURIComponent(inviteFromUrl)}` : ""}`;

    return (
      <div className="household-page container page-enter">
        {header}
        {inviteFromUrl ? (
          <Card className="household-invite-arrival" variant="raised">
            <span className="household-invite-arrival-icon" aria-hidden="true">
              <Icon name="gift" size={24} />
            </span>
            <div className="household-invite-arrival-copy">
              <h2>You&apos;re invited to a household</h2>
              <p>
                Sign in with the email address the invite was sent to, and we&apos;ll bring you
                straight back here to join.
              </p>
            </div>
            <ButtonLink icon="log-in" to={signInPath}>
              Sign in to join
            </ButtonLink>
          </Card>
        ) : null}
        <FamilyExplainer
          action={
            inviteFromUrl ? null : (
              <ButtonLink icon="log-in" to={signInPath}>
                Sign in to get started
              </ButtonLink>
            )
          }
          actionNote={
            <>
              Starting a household needs LinkDish Family.{" "}
              <Link to="/pricing?upgrade=family">See plans</Link>
            </>
          }
        />
      </div>
    );
  }

  if (loadState === "loading" && !household) {
    return (
      <div className="household-page container page-enter" aria-busy="true">
        {header}
        <div aria-label="Loading household" className="household-skeleton" role="status">
          <Skeleton height={28} width="40%" />
          {[0, 1, 2].map((row) => (
            <div className="household-skeleton-row" key={row}>
              <Skeleton height={40} shape="circle" width={40} />
              <Skeleton height={16} width="55%" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (loadState === "error" && !household) {
    return (
      <div className="household-page container page-enter">
        {header}
        <ErrorState
          message={loadError}
          onRetry={() => void loadHousehold()}
          title="We couldn't load your household"
        />
      </div>
    );
  }

  const actionErrorBanner = actionError ? (
    <p className="household-error" role="alert">
      <Icon name="alert-circle" size={18} />
      <span>{actionError}</span>
    </p>
  ) : null;

  if (!household) {
    const joinCard = (
      <Card className="household-card" variant={inviteFromUrl ? "raised" : "default"}>
        <div className="household-card-heading">
          <h2>{inviteFromUrl ? "Join the household you were invited to" : "Got an invite?"}</h2>
          <p>
            {inviteFromUrl
              ? `Use the account for the email address the invite was sent to${user?.email ? ` (you're signed in as ${user.email})` : ""}.`
              : "Join someone else's household with the code or link from your invite email."}
          </p>
        </div>
        <JoinHouseholdForm
          busy={busyAction === "join"}
          highlighted={Boolean(inviteFromUrl)}
          initialCode={inviteFromUrl}
          onJoin={joinHousehold}
        />
      </Card>
    );

    return (
      <div className="household-page container page-enter">
        {header}
        {actionErrorBanner}
        {inviteFromUrl ? joinCard : null}
        <FamilyExplainer
          action={
            <Button
              icon={plan === "family" ? "plus" : "users"}
              loading={busyAction === "create"}
              onClick={startHousehold}
              variant={inviteFromUrl ? "secondary" : "primary"}
            >
              Create household
            </Button>
          }
          actionNote={
            plan === "family" ? (
              "You're on Family, so you can start one now and invite up to five people."
            ) : (
              <>
                Starting a household needs LinkDish Family.{" "}
                <Link to="/pricing?upgrade=family">Compare plans</Link>
              </>
            )
          }
        />
        {inviteFromUrl ? null : joinCard}
      </div>
    );
  }

  const owner = getHouseholdOwner(household);
  const ownerName = owner ? getMemberDisplayName(owner) : "the owner";
  const pendingCount = household.invites.length;
  const openSpots = Math.max(
    household.memberLimit -
      household.activeMemberCount -
      household.cooldownSlotCount -
      pendingCount,
    0
  );
  // One dot per spot: members, then invites waiting, then spots in their cooldown, then open.
  const seats: Array<"used" | "invited" | "cooling" | "open"> = [
    ...Array<"used">(household.activeMemberCount).fill("used"),
    ...Array<"invited">(pendingCount).fill("invited"),
    ...Array<"cooling">(household.cooldownSlotCount).fill("cooling"),
    ...Array<"open">(openSpots).fill("open")
  ].slice(0, household.memberLimit);
  const seatSummary = [
    `${household.activeMemberCount} of ${household.memberLimit} spots used`,
    pendingCount > 0 ? `${pendingCount} invited` : "",
    household.cooldownSlotCount > 0 ? `${household.cooldownSlotCount} opening up soon` : ""
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="household-page container page-enter">
      {header}
      {actionErrorBanner}

      {!household.ownerFamilyEntitlementActive ? (
        <Card className="household-paused" variant="subtle">
          <Icon name="alert-triangle" size={20} />
          <div>
            <h2>Sharing is paused</h2>
            <p>
              {isOwner
                ? "Your Family plan isn't active, so the household can't sync. Renew Family to pick up where you left off."
                : `${ownerName}'s Family plan isn't active right now, so sharing is paused until it's renewed.`}
            </p>
          </div>
          {isOwner ? (
            <ButtonLink size="sm" to="/pricing?upgrade=family">
              Renew Family
            </ButtonLink>
          ) : null}
        </Card>
      ) : null}

      <Card className="household-card" padding="none" variant="default">
        <div className="household-card-head">
          <div className="household-card-heading">
            <h2>People</h2>
            <p className="num">{seatSummary}</p>
          </div>
          <div aria-hidden="true" className="household-seats" title={seatSummary}>
            {seats.map((seat, index) => (
              <span className={`household-seat is-${seat}`} key={index} />
            ))}
          </div>
        </div>
        <ul className="household-members">
          {members.map((member) => (
            <MemberRow
              canRemove={isOwner && member.role !== "owner"}
              disabled={busyAction !== null && busyAction !== `remove-${member.userId}`}
              isYou={member.userId === user?.id}
              key={member.userId}
              member={member}
              onRemove={setMemberToRemove}
              removing={busyAction === `remove-${member.userId}`}
            />
          ))}
        </ul>
      </Card>

      {isOwner ? (
        <Card className="household-card" variant="default">
          <div className="household-card-heading">
            <h2>Invite someone</h2>
            <p>
              {openSpots > 0
                ? `We'll email them an invite. They'll need to sign in with that address to join. ${openSpots} ${openSpots === 1 ? "spot" : "spots"} left.`
                : "Every spot is taken or waiting on an invite right now."}
            </p>
          </div>
          <form className="household-invite-form" noValidate onSubmit={sendInvite}>
            <Field
              autoComplete="email"
              disabled={openSpots === 0}
              error={inviteEmailError ?? undefined}
              inputMode="email"
              label="Their email"
              leadingIcon="mail"
              onChange={(event) => {
                setInviteEmail(event.target.value);
                setInviteEmailError(null);
              }}
              placeholder="name@example.com"
              type="email"
              value={inviteEmail}
            />
            <Button
              disabled={!inviteEmail.trim() || openSpots === 0}
              icon="send"
              loading={busyAction === "invite"}
              type="submit"
            >
              Send invite
            </Button>
          </form>

          {lastInvite ? (
            <div className="household-invite-created">
              <p className="household-invite-created-title">
                <Icon name="check-circle" size={18} />
                <span>
                  Invite sent to <strong>{lastInvite.email}</strong>. You can also share it
                  yourself:
                </span>
              </p>
              <InviteShareActions
                expanded
                inviteCode={lastInvite.inviteCode}
                inviteEmail={lastInvite.email}
              />
            </div>
          ) : null}

          {household.invites.length > 0 ? (
            <div className="household-pending-section">
              <h3>
                Waiting to join <Badge tone="neutral">{household.invites.length}</Badge>
              </h3>
              <ul className="household-pending-list">
                {household.invites.map((invite) => (
                  <PendingInviteRow
                    cancelling={busyAction === `cancel-${invite.id}`}
                    email={invite.email}
                    expiresAt={invite.expiresAt}
                    inviteCode={rememberedCodes[invite.id]}
                    key={invite.id}
                    onCancel={() => setInviteToCancel({ email: invite.email, id: invite.id })}
                  />
                ))}
              </ul>
            </div>
          ) : null}
        </Card>
      ) : null}

      <nav aria-label="Shared spaces" className="household-shortcuts">
        <Link className="household-shortcut" to="/">
          <span className="household-shortcut-icon">
            <Icon name="book-open" size={20} />
          </span>
          <span className="household-shortcut-copy">
            <strong>Shared cookbook</strong>
            <span>Recipes you save are shared with the household</span>
          </span>
          <Icon className="household-shortcut-chevron" name="chevron-right" size={18} />
        </Link>
        <Link className="household-shortcut" to="/shopping">
          <span className="household-shortcut-icon">
            <Icon name="shopping-basket" size={20} />
          </span>
          <span className="household-shortcut-copy">
            <strong>Household shopping list</strong>
            <span>Everyone adds and checks off the same list</span>
          </span>
          <Icon className="household-shortcut-chevron" name="chevron-right" size={18} />
        </Link>
      </nav>

      {!isOwner ? (
        <div className="household-leave">
          <Button
            icon="log-out"
            loading={busyAction === "leave"}
            onClick={() => setConfirmLeave(true)}
            variant="outline-danger"
          >
            Leave household
          </Button>
        </div>
      ) : null}

      <ConfirmationDialog
        cancelLabel="Keep invite"
        confirmLabel="Cancel invite"
        confirmLoading={inviteToCancel ? busyAction === `cancel-${inviteToCancel.id}` : false}
        message={
          inviteToCancel ? `This stops ${inviteToCancel.email} from joining with this invite.` : ""
        }
        onCancel={() => setInviteToCancel(null)}
        onConfirm={() => {
          if (inviteToCancel) {
            void cancelInvite(inviteToCancel.id);
          }
        }}
        title="Cancel invite?"
        visible={inviteToCancel !== null}
      />

      <ConfirmationDialog
        cancelLabel="Keep them"
        confirmLabel="Remove"
        confirmLoading={memberToRemove ? busyAction === `remove-${memberToRemove.userId}` : false}
        message={
          memberToRemove ? (
            <p>
              {getMemberDisplayName(memberToRemove)} will lose access to the shared cookbook and
              shopping list, and the recipes they shared leave the household. Their spot takes a
              while to open up again.
            </p>
          ) : (
            ""
          )
        }
        onCancel={() => setMemberToRemove(null)}
        onConfirm={() => {
          if (memberToRemove) {
            void removeMember(memberToRemove);
          }
        }}
        title={
          memberToRemove ? `Remove ${getMemberDisplayName(memberToRemove)}?` : "Remove member?"
        }
        visible={memberToRemove !== null}
      />

      <ConfirmationDialog
        cancelLabel="Stay"
        confirmLabel="Leave household"
        confirmLoading={busyAction === "leave"}
        message={
          <p>
            You&apos;ll lose access to the shared cookbook and shopping list, and recipes you shared
            leave the household. Recipes saved on this device stay in your cookbook.
          </p>
        }
        onCancel={() => setConfirmLeave(false)}
        onConfirm={() => void leaveHousehold()}
        title={`Leave ${ownerName}'s household?`}
        visible={confirmLeave}
      />
    </div>
  );
};
