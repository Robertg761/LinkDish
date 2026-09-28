import React, { useState } from "react";

import { Badge } from "../../components/Badge";
import { Button } from "../../components/Button";
import { Icon } from "../../components/Icon";
import { retryLinkDishStorage, useLinkDishDbStatus } from "../../data/storage-status";
import { formatBytes, requestPersistence } from "../data-transfer/device-storage";

import { useDeviceStorage } from "./use-device-storage";

import type { IconName } from "../../components/Icon";
import type { LinkDishDbStatus } from "../../storage/linkdish-db";
import type { LocalDataCounts } from "../data-transfer/local-data";

const RETRY_SPINNER_MS = 4_000;

interface StorageCardProps {
  counts: LocalDataCounts | null;
  /** Signed in with a Family plan: shared recipes also live with the household. */
  isFamily: boolean;
}

const plural = (count: number, one: string, many = `${one}s`): string =>
  `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;

interface DbProblem {
  title: string;
  body: string;
  action: "reload" | "retry";
  actionLabel: string;
}

const describeDbProblem = (status: LinkDishDbStatus): DbProblem | null => {
  switch (status.state) {
    case "blocked":
      return {
        title: "Another LinkDish tab is holding things up",
        body: "Close other LinkDish tabs or windows so this one can finish updating your cookbook.",
        action: "retry",
        actionLabel: "Try again"
      };
    case "outdated":
      return {
        title: "LinkDish was updated in another tab",
        body: "Reload this page to keep going with the latest version.",
        action: "reload",
        actionLabel: "Reload to keep going"
      };
    case "terminated":
    case "error":
      return {
        title: "Your cookbook storage isn't responding",
        body: "The browser closed LinkDish's storage. Your recipes are usually still there — try again.",
        action: "retry",
        actionLabel: "Try again"
      };
    default:
      return null;
  }
};

const StatTile: React.FC<{ icon: IconName; value: number | null; label: string }> = ({
  icon,
  value,
  label
}) => (
  <div className="settings-data-stat">
    <span className="settings-data-stat-icon" aria-hidden="true">
      <Icon name={icon} size={18} />
    </span>
    <span className="settings-data-stat-value num">
      {value === null ? "–" : value.toLocaleString("en-US")}
    </span>
    <span className="settings-data-stat-label">{label}</span>
  </div>
);

export const StorageCard: React.FC<StorageCardProps> = ({ counts, isFamily }) => {
  const { estimate, persistence, refresh } = useDeviceStorage();
  const dbStatus = useLinkDishDbStatus();
  const [persistState, setPersistState] = useState<"idle" | "asking" | "denied">("idle");
  const [retrying, setRetrying] = useState(false);
  const problem = describeDbProblem(dbStatus);

  const handleProtect = async () => {
    setPersistState("asking");
    const result = await requestPersistence();
    setPersistState(result === "granted" ? "idle" : "denied");
    refresh();
  };

  const handleProblemAction = async () => {
    if (problem?.action === "reload") {
      window.location.reload();
      return;
    }

    setRetrying(true);
    // A blocked open finishes by itself once other tabs let go; don't spin forever meanwhile.
    await Promise.race([
      retryLinkDishStorage(),
      new Promise((resolve) => window.setTimeout(resolve, RETRY_SPINNER_MS))
    ]);
    setRetrying(false);
    refresh();
  };

  const usage = estimate?.usage ?? null;
  const quota = estimate?.quota ?? null;

  return (
    <div className="settings-card settings-data-card" data-testid="storage-card">
      <div className="settings-data-card-header">
        <span className="settings-data-card-icon" aria-hidden="true">
          <Icon name="smartphone" size={20} />
        </span>
        <div className="settings-data-card-heading">
          <h3 className="settings-data-card-title">Storage on this device</h3>
          <p className="settings-data-card-text">
            {estimate === null
              ? "Checking how much space LinkDish uses…"
              : estimate.supported && usage !== null
                ? `LinkDish is using ${formatBytes(usage)}${quota ? ` of about ${formatBytes(quota)} this browser allows` : ""}.`
                : "This browser doesn't say how much space LinkDish uses."}
          </p>
        </div>
      </div>

      {problem ? (
        <div className="settings-data-alert" role="alert">
          <Icon name="alert-triangle" size={18} />
          <div className="settings-data-alert-copy">
            <strong>{problem.title}</strong>
            <span>{problem.body}</span>
          </div>
          <Button
            loading={retrying}
            onClick={() => void handleProblemAction()}
            size="sm"
            variant="secondary"
          >
            {problem.actionLabel}
          </Button>
        </div>
      ) : null}

      <div className="settings-data-stats">
        <StatTile icon="book-open" label="Recipes" value={counts?.recipes ?? null} />
        <StatTile icon="folder" label="Collections" value={counts?.collections ?? null} />
        <StatTile icon="calendar-days" label="Meals" value={counts?.mealPlanEntries ?? null} />
      </div>
      {counts && counts.starters > 0 ? (
        <p className="settings-data-footnote">
          Plus {plural(counts.starters, "starter recipe")} LinkDish added to get you going. They
          don&apos;t count toward the free limit.
        </p>
      ) : null}

      <div className="settings-divider" />

      <div className="settings-data-protect">
        <div className="settings-data-protect-copy">
          <div className="settings-data-protect-title">
            <span>Keep my recipes safe</span>
            {persistence === "persisted" ? (
              <Badge icon="shield-check" tone="success">
                Protected
              </Badge>
            ) : persistence === "not_persisted" ? (
              <Badge tone="butter">Not protected yet</Badge>
            ) : null}
          </div>
          <p className="settings-data-card-text">
            {persistence === "persisted"
              ? "Your browser has promised not to clear LinkDish's data when the device runs low on space."
              : persistence === "unsupported"
                ? "This browser decides on its own when to clear website data. A backup file is the safest way to keep your recipes."
                : persistState === "denied"
                  ? "Your browser said not yet — it often agrees once LinkDish is installed or used more. A backup always works."
                  : "Ask your browser not to clear LinkDish's data when the device runs low on space."}
          </p>
        </div>
        {persistence === "not_persisted" ? (
          <Button
            icon="shield-check"
            loading={persistState === "asking"}
            onClick={() => void handleProtect()}
            size="sm"
            variant="tonal"
          >
            Protect my recipes
          </Button>
        ) : null}
      </div>

      <div className="settings-data-explainer">
        <Icon name="info" size={16} />
        <p>
          Your recipes live in this browser, on this device. Clearing browsing data or uninstalling
          the browser removes them, so download a backup now and then.{" "}
          {isFamily
            ? "Recipes you share with your Family household are also kept with the household."
            : "With Family, recipes you share are also kept with your household."}
        </p>
      </div>
    </div>
  );
};
