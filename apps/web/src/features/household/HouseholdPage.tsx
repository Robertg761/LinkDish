import React, { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";

import { apiClient } from "../../api/client";
import { useAuth } from "../../auth/AuthProvider";
import { Button, ButtonLink } from "../../components/Button";
import { Card } from "../../components/Card";
import { Chip } from "../../components/Chip";
import { ConfirmationDialog } from "../../components/ConfirmationDialog";
import { ErrorState } from "../../components/ErrorState";
import { Field } from "../../components/Field";
import { Icon } from "../../components/Icon";
import "./HouseholdPage.css";

import type {
  HouseholdDetails,
  HouseholdInviteShare,
  HouseholdMember
} from "@linkdish/api-contracts";

const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "Household action failed.";

const getMemberName = (member: HouseholdMember): string =>
  member.displayName?.trim() || member.email;

const formatInviteExpiry = (expiresAt: string): string => {
  const date = new Date(expiresAt);

  if (Number.isNaN(date.getTime())) {
    return "Expiration unavailable";
  }

  return `Expires ${date.toLocaleDateString()} at ${date.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit"
  })}`;
};

export const HouseholdPage: React.FC = () => {
  const { isAuthenticated, user, refreshUser } = useAuth();
  const [searchParams] = useSearchParams();
  const [household, setHousehold] = useState<HouseholdDetails | null>(null);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteCode, setInviteCode] = useState(searchParams.get("invite") ?? "");
  const [lastInvite, setLastInvite] = useState<HouseholdInviteShare | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [invitePendingCancellation, setInvitePendingCancellation] = useState<{
    email: string;
    id: string;
  } | null>(null);

  const groupedMembers = useMemo(
    () => ({
      members: household?.members.filter((member) => member.role !== "owner") ?? [],
      owners: household?.members.filter((member) => member.role === "owner") ?? []
    }),
    [household]
  );

  const refreshHousehold = async () => {
    if (!isAuthenticated) {
      setHousehold(null);
      return;
    }

    setLoading(true);
    setError("");

    try {
      const response = await apiClient.getHousehold();
      setHousehold(response.household);
    } catch (loadError) {
      setError(getErrorMessage(loadError));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refreshHousehold();
  }, [isAuthenticated]);

  const runHouseholdAction = async (
    actionName: string,
    action: () => Promise<HouseholdDetails | null>,
    options: { refreshAccount?: boolean } = {}
  ) => {
    setBusyAction(actionName);
    setError("");

    try {
      setHousehold(await action());

      if (options.refreshAccount) {
        await refreshUser();
      }
    } catch (actionError) {
      setError(getErrorMessage(actionError));
    } finally {
      setBusyAction(null);
    }
  };

  const createHousehold = () =>
    runHouseholdAction("create", async () => {
      const response = await apiClient.createHousehold();
      return response.household;
    });

  const sendInvite = (event: React.FormEvent) => {
    event.preventDefault();

    void runHouseholdAction("invite", async () => {
      const response = await apiClient.createHouseholdInvite({ email: inviteEmail.trim() });
      setLastInvite(response.invite);
      setInviteEmail("");
      return response.household;
    });
  };

  const acceptInvite = (event: React.FormEvent) => {
    event.preventDefault();

    void runHouseholdAction(
      "accept",
      async () => {
        const response = await apiClient.acceptHouseholdInvite({ inviteCode });
        setInviteCode("");
        return response.household;
      },
      { refreshAccount: true }
    );
  };

  const cancelInvite = (inviteId: string) =>
    runHouseholdAction("cancel-invite", async () => {
      const response = await apiClient.cancelHouseholdInvite({ inviteId });
      setLastInvite((invite) => (invite?.id === inviteId ? null : invite));
      return response.household;
    });

  const removeMember = (member: HouseholdMember) =>
    runHouseholdAction("remove-member", async () => {
      const response = await apiClient.removeHouseholdMember({ userId: member.userId });
      return response.household;
    });

  const leaveHousehold = () =>
    runHouseholdAction(
      "leave",
      async () => {
        const response = await apiClient.leaveHousehold();
        return response.household;
      },
      { refreshAccount: true }
    );

  const copyInvite = async (invite: HouseholdInviteShare) => {
    try {
      await navigator.clipboard.writeText(invite.inviteUrl || invite.inviteCode);
    } catch {
      setError("Could not copy the invite. Use the code shown below.");
    }
  };

  if (!isAuthenticated) {
    return (
      <div className="household-page container page-enter">
        <Card className="household-empty-card" variant="default">
          <h1>Household</h1>
          <p>Sign in to create or join a LinkDish Family household.</p>
          <ButtonLink
            to={`/account${inviteCode ? `?invite=${encodeURIComponent(inviteCode)}` : ""}`}
          >
            Sign in
          </ButtonLink>
        </Card>
      </div>
    );
  }

  return (
    <div className="household-page container page-enter">
      <header className="household-header">
        <Chip variant={household ? "accent" : "default"}>
          {household ? "Household active" : "No household"}
        </Chip>
        <h1>Household</h1>
        <p>
          Manage the Family recipe book connected to{" "}
          {user?.displayName || user?.email || "your account"}.
        </p>
      </header>

      {error && <ErrorState message={error} />}

      {loading ? (
        <p className="household-loading">Loading household...</p>
      ) : household ? (
        <>
          <Card className="household-card" variant="default">
            <div className="household-card-header">
              <div>
                <h2>Members</h2>
                <p>
                  {household.activeMemberCount} of {household.memberLimit} active member slots used.
                </p>
              </div>
              <Chip variant={household.ownerFamilyEntitlementActive ? "accent" : "default"}>
                {household.ownerFamilyEntitlementActive ? "Family active" : "Family inactive"}
              </Chip>
            </div>

            <div className="household-member-list">
              {[...groupedMembers.owners, ...groupedMembers.members].map((member) => (
                <div className="household-member-row" key={member.userId}>
                  <div className="household-avatar">{member.avatarEmoji || "LD"}</div>
                  <div className="household-member-copy">
                    <strong>{getMemberName(member)}</strong>
                    <span>{member.email}</span>
                  </div>
                  <Chip variant={member.role === "owner" ? "accent" : "default"}>
                    {member.role === "owner" ? "Owner" : "Member"}
                  </Chip>
                  {household.role === "owner" && member.role !== "owner" && (
                    <Button
                      variant="outline-danger"
                      onClick={() => {
                        void removeMember(member);
                      }}
                      loading={busyAction === "remove-member"}
                    >
                      Remove
                    </Button>
                  )}
                </div>
              ))}
            </div>
          </Card>

          {household.role === "owner" && (
            <Card className="household-card" variant="default">
              <h2>Invite Someone</h2>
              <form className="household-form" onSubmit={sendInvite}>
                <Field
                  id="household-invite-email"
                  type="email"
                  placeholder="name@example.com"
                  value={inviteEmail}
                  onChange={(event) => setInviteEmail(event.target.value)}
                  required
                />
                <Button
                  type="submit"
                  loading={busyAction === "invite"}
                  disabled={!inviteEmail.trim()}
                >
                  Send invite
                </Button>
              </form>

              {lastInvite && (
                <div className="household-invite-share">
                  <div>
                    <strong>Invite code</strong>
                    <code>{lastInvite.inviteCode}</code>
                    <span>{formatInviteExpiry(lastInvite.expiresAt)}</span>
                  </div>
                  <Button
                    variant="outline"
                    onClick={() => {
                      void copyInvite(lastInvite);
                    }}
                  >
                    <Icon name="content-copy" size={18} /> Copy
                  </Button>
                </div>
              )}

              {household.invites.length > 0 && (
                <div className="household-pending-list">
                  <h3>Pending invites</h3>
                  {household.invites.map((invite) => (
                    <div className="household-pending-row" key={invite.id}>
                      <span>{invite.email}</span>
                      <span>{formatInviteExpiry(invite.expiresAt)}</span>
                      <Button
                        variant="ghost"
                        onClick={() => {
                          setInvitePendingCancellation({ email: invite.email, id: invite.id });
                        }}
                        loading={busyAction === "cancel-invite"}
                      >
                        Cancel
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          )}

          <Card className="household-card" variant="subtle">
            <h2>Join With Invite Code</h2>
            <form className="household-form" onSubmit={acceptInvite}>
              <Field
                id="household-invite-code"
                value={inviteCode}
                onChange={(event) => setInviteCode(event.target.value)}
                placeholder="Invite code"
              />
              <Button
                type="submit"
                variant="outline"
                loading={busyAction === "accept"}
                disabled={!inviteCode.trim()}
              >
                Accept invite
              </Button>
            </form>
          </Card>

          <div className="household-footer-actions">
            <Button
              variant="outline-danger"
              onClick={() => {
                void leaveHousehold();
              }}
              loading={busyAction === "leave"}
            >
              Leave household
            </Button>
          </div>
        </>
      ) : (
        <>
          <div className="household-grid">
            <Card className="household-card" variant="default">
              <h2>Create a household</h2>
              <p>Start a Family recipe book and invite members.</p>
              <Button onClick={createHousehold} loading={busyAction === "create"}>
                Create household
              </Button>
            </Card>

            <Card className="household-card" variant="default">
              <h2>Join a household</h2>
              <form className="household-form" onSubmit={acceptInvite}>
                <Field
                  id="household-invite-code"
                  value={inviteCode}
                  onChange={(event) => setInviteCode(event.target.value)}
                  placeholder="Invite code"
                />
                <Button
                  type="submit"
                  variant="outline"
                  loading={busyAction === "accept"}
                  disabled={!inviteCode.trim()}
                >
                  Accept invite
                </Button>
              </form>
            </Card>
          </div>
        </>
      )}

      <ConfirmationDialog
        cancelLabel="Keep invite"
        confirmLabel="Cancel invite"
        confirmLoading={busyAction === "cancel-invite"}
        message={
          invitePendingCancellation
            ? `This stops ${invitePendingCancellation.email} from joining with this invite.`
            : ""
        }
        onCancel={() => setInvitePendingCancellation(null)}
        onConfirm={() => {
          if (!invitePendingCancellation) {
            return;
          }

          void cancelInvite(invitePendingCancellation.id).finally(() => {
            setInvitePendingCancellation(null);
          });
        }}
        title="Cancel invite?"
        visible={invitePendingCancellation != null}
      />
    </div>
  );
};
