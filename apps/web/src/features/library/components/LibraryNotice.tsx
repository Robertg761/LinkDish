import React from "react";

import { Icon } from "../../../components/Icon";
import { retryLinkDishStorage, useLinkDishDbStatus } from "../../../data/storage-status";

import type { IconName } from "../../../components/Icon";

import "./LibraryNotice.css";

interface LibraryNoticeProps {
  icon: IconName;
  tone?: "neutral" | "warning" | undefined;
  children: React.ReactNode;
  /** Buttons or links on the right. */
  actions?: React.ReactNode;
  role?: "status" | "alert" | undefined;
}

/** A slim inline banner for page-level notices (storage, Family access). */
export const LibraryNotice: React.FC<LibraryNoticeProps> = ({
  icon,
  tone = "neutral",
  children,
  actions,
  role = "status"
}) => (
  <div className={`library-notice library-notice-${tone}`} role={role}>
    <span aria-hidden="true" className="library-notice-icon">
      <Icon name={icon} size={18} />
    </span>
    <div className="library-notice-text">{children}</div>
    {actions ? <div className="library-notice-actions">{actions}</div> : null}
  </div>
);

/**
 * Tells people when on-device storage needs them: another tab upgraded it ("outdated"), an old tab
 * is holding the upgrade back ("blocked"), or the browser closed the connection ("terminated").
 */
export const LibraryStorageBanner: React.FC = () => {
  const status = useLinkDishDbStatus();

  if (status.state === "outdated") {
    return (
      <LibraryNotice
        actions={
          <button
            className="library-notice-button"
            onClick={() => window.location.reload()}
            type="button"
          >
            Reload
          </button>
        }
        icon="refresh"
        tone="warning"
      >
        LinkDish was updated in another tab. Reload to keep going.
      </LibraryNotice>
    );
  }

  if (status.state === "blocked") {
    return (
      <LibraryNotice icon="alert-triangle" tone="warning">
        Close other LinkDish tabs to finish updating your cookbook.
      </LibraryNotice>
    );
  }

  if (status.state === "terminated") {
    return (
      <LibraryNotice
        actions={
          <button
            className="library-notice-button"
            onClick={() => {
              void retryLinkDishStorage();
            }}
            type="button"
          >
            Reconnect
          </button>
        }
        icon="alert-triangle"
        tone="warning"
      >
        Your browser closed this tab&rsquo;s connection to your saved recipes.
      </LibraryNotice>
    );
  }

  return null;
};
