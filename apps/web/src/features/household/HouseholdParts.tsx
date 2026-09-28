import React, { useState } from "react";

import { Badge } from "../../components/Badge";
import { Button } from "../../components/Button";
import { Field } from "../../components/Field";
import { Icon } from "../../components/Icon";
import { useToast } from "../../components/Toast";

import {
  buildWebJoinLink,
  formatInviteExpiry,
  formatLinkForDisplay,
  getInviteCodeProblem,
  parseInviteInput
} from "./invite-links";
import { canUseSystemShare, copyText, shareOrCopy } from "./share-invite";
import { getInitials, getMemberDisplayName } from "./use-household-summary";

import type { HouseholdMember } from "@linkdish/api-contracts";

const AVATAR_TINTS = 3;

const tintFor = (seed: string): number => {
  let hash = 0;

  for (const char of seed) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }

  return hash % AVATAR_TINTS;
};

export const MemberAvatar: React.FC<{
  member: Pick<HouseholdMember, "avatarEmoji" | "displayName" | "email" | "userId">;
  size?: "md" | "lg" | undefined;
}> = ({ member, size = "md" }) => {
  const emoji = member.avatarEmoji?.trim();

  return (
    <span
      aria-hidden="true"
      className={`household-avatar household-avatar-${size} household-tint-${tintFor(member.userId)}${emoji ? " has-emoji" : ""}`}
    >
      {emoji || getInitials(getMemberDisplayName(member))}
    </span>
  );
};

interface MemberRowProps {
  member: HouseholdMember;
  isYou: boolean;
  canRemove: boolean;
  removing: boolean;
  disabled: boolean;
  onRemove: (member: HouseholdMember) => void;
}

export const MemberRow: React.FC<MemberRowProps> = ({
  member,
  isYou,
  canRemove,
  removing,
  disabled,
  onRemove
}) => {
  // Without a display name, the email is the name (not "jo.bennett" over the same email).
  const hasDisplayName = Boolean(member.displayName?.trim());
  const name = hasDisplayName ? getMemberDisplayName(member) : member.email;
  const showEmail = hasDisplayName && name !== member.email;

  return (
    <li className="household-member">
      <MemberAvatar member={member} />
      <span className="household-member-copy">
        <span className="household-member-name">
          <span className="household-member-name-text">{name}</span>
          {member.role === "owner" ? (
            <Badge className="household-owner-badge" icon="crown" tone="butter">
              Owner
            </Badge>
          ) : null}
          {isYou ? <Badge tone="primary">You</Badge> : null}
        </span>
        {showEmail ? <span className="household-member-email">{member.email}</span> : null}
      </span>
      {/* Neutral until confirmed: the confirmation dialog carries the red. */}
      {canRemove ? (
        <Button
          aria-label={`Remove ${getMemberDisplayName(member)}`}
          className="household-member-remove"
          disabled={disabled}
          loading={removing}
          onClick={() => onRemove(member)}
          size="sm"
          variant="ghost"
        >
          Remove
        </Button>
      ) : null}
    </li>
  );
};

interface InviteShareActionsProps {
  inviteCode: string;
  inviteEmail: string;
  /** Show the code and link in full (right after creating an invite). */
  expanded?: boolean | undefined;
}

/** Share / copy actions for an invite: the system share sheet when available, else copy. */
export const InviteShareActions: React.FC<InviteShareActionsProps> = ({
  inviteCode,
  inviteEmail,
  expanded = false
}) => {
  const { showToast } = useToast();
  const link = buildWebJoinLink(inviteCode);
  const systemShare = canUseSystemShare();

  const share = async () => {
    const outcome = await shareOrCopy({
      text: `Join my LinkDish household so we can share recipes and a shopping list. Sign in with ${inviteEmail} to accept.`,
      title: "Join my LinkDish household",
      url: link
    });

    if (outcome === "copied") {
      showToast({ message: "Invite link copied", tone: "success" });
    } else if (outcome === "failed") {
      showToast({
        message: "Couldn't copy the link. Select it and copy it yourself.",
        tone: "danger"
      });
    }
  };

  const copy = async (text: string, label: string) => {
    if (await copyText(text)) {
      showToast({ message: `${label} copied`, tone: "success" });
    } else {
      showToast({
        message: "Couldn't copy that. Select it and copy it yourself.",
        tone: "danger"
      });
    }
  };

  if (!expanded) {
    // Pending-invite rows get one quiet button: share where the system can, copy elsewhere.
    return systemShare ? (
      <Button
        aria-label={`Share invite for ${inviteEmail}`}
        icon="share-up"
        onClick={() => void share()}
        size="sm"
        variant="secondary"
      >
        Share
      </Button>
    ) : (
      <Button
        aria-label={`Copy invite link for ${inviteEmail}`}
        icon="link"
        onClick={() => void copy(link, "Invite link")}
        size="sm"
        variant="secondary"
      >
        Copy link
      </Button>
    );
  }

  return (
    <div className="household-invite-share">
      <dl className="household-invite-details">
        <div>
          <dt>Join link</dt>
          <dd>
            <a className="household-invite-link" href={link}>
              {formatLinkForDisplay(link)}
            </a>
          </dd>
        </div>
        <div>
          <dt>Invite code</dt>
          <dd>
            <code className="household-invite-code">{inviteCode}</code>
          </dd>
        </div>
      </dl>
      <div className="household-invite-buttons">
        {systemShare ? (
          <Button icon="share-up" onClick={() => void share()} size="sm" variant="primary">
            Share invite
          </Button>
        ) : null}
        <Button
          icon="link"
          onClick={() => void copy(link, "Invite link")}
          size="sm"
          variant={systemShare ? "secondary" : "primary"}
        >
          Copy link
        </Button>
        <Button
          icon="copy"
          onClick={() => void copy(inviteCode, "Invite code")}
          size="sm"
          variant="secondary"
        >
          Copy code
        </Button>
      </div>
    </div>
  );
};

interface PendingInviteRowProps {
  email: string;
  expiresAt: string;
  inviteCode: string | undefined;
  onCancel: () => void;
  cancelling: boolean;
}

export const PendingInviteRow: React.FC<PendingInviteRowProps> = ({
  email,
  expiresAt,
  inviteCode,
  onCancel,
  cancelling
}) => (
  <li className="household-pending">
    <span className="household-pending-icon" aria-hidden="true">
      <Icon name="mail" size={16} />
    </span>
    <span className="household-pending-copy">
      <span className="household-pending-email">{email}</span>
      <span className="household-pending-meta">
        {formatInviteExpiry(expiresAt)}
        {inviteCode ? "" : <span className="household-pending-sent"> · sent by email</span>}
      </span>
    </span>
    <span className="household-pending-actions">
      {inviteCode ? <InviteShareActions inviteCode={inviteCode} inviteEmail={email} /> : null}
      <Button
        aria-label={`Cancel invite for ${email}`}
        loading={cancelling}
        onClick={onCancel}
        size="sm"
        variant="ghost"
      >
        Cancel
      </Button>
    </span>
  </li>
);

interface JoinHouseholdFormProps {
  initialCode: string;
  busy: boolean;
  onJoin: (inviteCode: string) => void;
  /** Visually emphasise (when the person arrived from an invite link). */
  highlighted?: boolean | undefined;
}

export const JoinHouseholdForm: React.FC<JoinHouseholdFormProps> = ({
  initialCode,
  busy,
  onJoin,
  highlighted = false
}) => {
  const [value, setValue] = useState(initialCode);
  const [problem, setProblem] = useState<string | null>(null);

  return (
    <form
      className={`household-join${highlighted ? " is-highlighted" : ""}`}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        const nextProblem = getInviteCodeProblem(value);
        setProblem(nextProblem);

        if (!nextProblem) {
          onJoin(parseInviteInput(value));
        }
      }}
    >
      <Field
        autoCapitalize="off"
        autoComplete="off"
        error={problem ?? undefined}
        label="Invite code or link"
        leadingIcon="gift"
        placeholder="Paste your invite link or code"
        onChange={(event) => {
          setValue(event.target.value);

          if (problem) {
            setProblem(null);
          }
        }}
        spellCheck={false}
        value={value}
      />
      <Button
        disabled={!value.trim()}
        loading={busy}
        type="submit"
        variant={highlighted ? "primary" : "secondary"}
      >
        Join household
      </Button>
    </form>
  );
};
