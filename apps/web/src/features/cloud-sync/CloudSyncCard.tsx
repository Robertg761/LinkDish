import React, { useState } from "react";

import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { Icon } from "../../components/Icon";

import {
  countChangesNotSynced,
  requestLibrarySyncNow,
  switchToAccountCookbook,
  useLibrarySyncStatus
} from "./library-sync-status";

import type { LibrarySyncStatus } from "./library-sync-status";

import "./CloudSyncCard.css";

const formatSyncedAt = (time: number, now = Date.now()): string =>
  now - time < 60_000
    ? "Synced just now."
    : `Last synced at ${new Date(time).toLocaleTimeString(undefined, {
        hour: "numeric",
        minute: "2-digit"
      })}.`;

const statusLine = (status: LibrarySyncStatus): string => {
  switch (status.phase) {
    case "syncing":
      return "Syncing your cookbook…";
    case "offline":
      return "You're offline. Changes made here sync when you're back online.";
    case "error":
      return status.error ?? "Your cookbook couldn't sync just now.";
    default:
      return status.lastSyncedAt ? formatSyncedAt(status.lastSyncedAt) : "";
  }
};

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** The step before replacing another account's cookbook on this browser with the signed-in one's. */
const SwitchCookbook: React.FC = () => {
  const [unsynced, setUnsynced] = useState<number | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [failed, setFailed] = useState(false);

  const ask = () => {
    setConfirming(true);
    setFailed(false);
    void countChangesNotSynced()
      .then(setUnsynced)
      .catch(() => setUnsynced(null));
  };

  const replace = () => {
    setSwitching(true);
    setFailed(false);
    void switchToAccountCookbook()
      .catch(() => setFailed(true))
      .finally(() => {
        setSwitching(false);
        setConfirming(false);
      });
  };

  if (!confirming) {
    return (
      <div className="cloud-sync-actions">
        <Button icon="refresh" onClick={ask} size="sm" variant="secondary">
          Use my cookbook here
        </Button>
      </div>
    );
  }

  return (
    <div className="cloud-sync-confirm" role="group" aria-label="Replace this browser's cookbook">
      <p>
        The recipes and collections on this browser are removed (starter recipes stay) and your own
        cookbook comes in. The other account keeps its cookbook in its cloud.
      </p>
      {unsynced ? (
        <p className="cloud-sync-warning">
          <Icon name="alert-triangle" size={16} />
          {plural(unsynced, "change", "changes")} made here haven&apos;t synced to the other account
          yet and will be lost.
        </p>
      ) : null}
      {failed ? (
        <p className="cloud-sync-warning" role="alert">
          <Icon name="alert-triangle" size={16} />
          This browser&apos;s cookbook couldn&apos;t be replaced. Try again.
        </p>
      ) : null}
      <div className="cloud-sync-actions">
        <Button disabled={switching} onClick={() => setConfirming(false)} size="sm" variant="ghost">
          Keep it
        </Button>
        <Button loading={switching} onClick={replace} size="sm" variant="danger">
          Replace with my cookbook
        </Button>
      </div>
    </div>
  );
};

/** Cloud sync's state on the Account page; nothing while it is off (or not switched on yet). */
export const CloudSyncCard: React.FC = () => {
  const status = useLibrarySyncStatus();
  const [retrying, setRetrying] = useState(false);

  if (status.phase === "off") {
    return null;
  }

  if (status.phase === "other_account") {
    return (
      <Card aria-labelledby="cloud-sync-title" className="cloud-sync" role="region">
        <div className="cloud-sync-head">
          <Icon name="cloud-off" size={20} />
          <h2 id="cloud-sync-title">This cookbook syncs with another account</h2>
        </div>
        <p className="cloud-sync-copy">
          The recipes on this browser belong to the account that signed in here first, so they
          don&apos;t sync with yours. Your own cookbook is safe in your account.
        </p>
        <SwitchCookbook />
      </Card>
    );
  }

  const line = statusLine(status);

  return (
    <Card aria-labelledby="cloud-sync-title" className="cloud-sync" role="region">
      <div className="cloud-sync-head">
        <Icon name={status.phase === "offline" ? "cloud-off" : "cloud-upload"} size={20} />
        <h2 id="cloud-sync-title">Cookbook sync</h2>
      </div>
      <p className="cloud-sync-copy">
        Your recipes, notes, favorites, tags, ratings, collections and cook log sync between this
        browser and the LinkDish app wherever you&apos;re signed in.
      </p>
      {line ? (
        <p
          className={`cloud-sync-status${status.phase === "error" ? " is-error" : ""}`}
          role="status"
        >
          {line}
        </p>
      ) : null}
      {status.held ? (
        <p className="cloud-sync-warning">
          <Icon name="alert-triangle" size={16} />
          {plural(status.held, "recipe or collection", "recipes or collections")} couldn&apos;t sync
          because {status.held === 1 ? "it's" : "they're"} too large or past a cookbook limit.{" "}
          {status.held === 1 ? "It stays" : "They stay"} on this browser.
        </p>
      ) : null}
      {status.phase === "error" || status.phase === "synced" ? (
        <div className="cloud-sync-actions">
          <Button
            icon="refresh"
            loading={retrying}
            onClick={() => {
              setRetrying(true);
              void requestLibrarySyncNow().finally(() => setRetrying(false));
            }}
            size="sm"
            variant="secondary"
          >
            {status.phase === "error" ? "Try again" : "Sync now"}
          </Button>
        </div>
      ) : null}
    </Card>
  );
};
