import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { getFriendlyErrorMessage } from "../../api/error-message";
import { Icon } from "../../components/Icon";

import { formatSyncedAgo } from "./shopping-format";

import type { ShoppingSyncState } from "./shopping-sync";

interface ShoppingSyncStatusProps {
  sync: ShoppingSyncState;
  signedIn: boolean;
  onRetry: () => void;
}

/** One quiet line saying where the list lives and whether the household copy is current. */
export const ShoppingSyncStatus: React.FC<ShoppingSyncStatusProps> = ({
  sync,
  signedIn,
  onRetry
}) => {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (sync.mode !== "household") {
      return;
    }

    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [sync.mode]);

  if (sync.mode !== "household") {
    return (
      <p className="shopping-status">
        <Icon name="smartphone" size={16} />
        <span>
          Saved on this device
          {sync.modeResolved ? (
            <>
              {" · "}
              <Link className="shopping-status-link" to={signedIn ? "/household" : "/account"}>
                Share with your household
              </Link>
            </>
          ) : null}
        </span>
      </p>
    );
  }

  if (sync.phase === "offline") {
    return (
      <p className="shopping-status is-offline" role="status">
        <Icon name="wifi-off" size={16} />
        <span>Offline · your changes will sync when you're back</span>
      </p>
    );
  }

  if (sync.phase === "error") {
    return (
      <div className="shopping-status is-error" role="status">
        <Icon name="alert-circle" size={16} />
        <span>{getFriendlyErrorMessage(sync.error, "shopping")}</span>
        <button className="shopping-status-retry" onClick={onRetry} type="button">
          Try again
        </button>
      </div>
    );
  }

  const detail =
    sync.phase === "syncing"
      ? "syncing…"
      : sync.lastSyncedAt
        ? `synced ${formatSyncedAgo(sync.lastSyncedAt, now)}`
        : "up to date";

  return (
    <p className="shopping-status is-household" role="status">
      <Icon name={sync.phase === "syncing" ? "refresh" : "users"} size={16} />
      <span>Shared with your household · {detail}</span>
    </p>
  );
};
