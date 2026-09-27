import React from "react";

import { Icon } from "../../components/Icon";

import type { IconName } from "../../components/Icon";
import type { InstallPlatform } from "../../platform/install-prompt";

/** The address every bookmarklet and share tip points at: the production web app. */
export const WEB_APP_ORIGIN = "https://app.linkdish.ca";

/**
 * "Save to LinkDish": sends the current page to the import screen, which starts automatically
 * when it gets ?url=. React 19 refuses javascript: URLs in JSX, so the page sets this on the
 * link's href attribute directly.
 */
export const BOOKMARKLET_HREF = `javascript:location.href='${WEB_APP_ORIGIN}/import?url='+encodeURIComponent(location.href)`;

export const PLAY_STORE_URL = "https://play.google.com/store/apps/details?id=com.linkdish.app";

export interface InstallStep {
  icon: IconName;
  content: React.ReactNode;
}

export interface PlatformGuide {
  id: InstallPlatform;
  title: string;
  browser: string;
  steps: InstallStep[];
  note?: React.ReactNode;
}

const Key: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <strong className="install-key">{children}</strong>
);

const InlineIcon: React.FC<{ name: IconName; label: string }> = ({ name, label }) => (
  <span className="install-inline-icon" role="img" aria-label={label}>
    <Icon name={name} size={15} strokeWidth={2.2} />
  </span>
);

export const PLATFORM_GUIDES: Record<InstallPlatform, PlatformGuide> = {
  android: {
    browser: "Chrome",
    id: "android",
    steps: [
      {
        content: (
          <>
            Tap the menu <InlineIcon label="three dots" name="more-vertical" /> at the top right of
            Chrome.
          </>
        ),
        icon: "more-vertical"
      },
      {
        content: (
          <>
            Tap <Key>Install app</Key> (or <Key>Add to Home screen</Key>).
          </>
        ),
        icon: "smartphone-download"
      },
      {
        content: (
          <>
            Tap <Key>Install</Key>. LinkDish now shows up in your share menu too.
          </>
        ),
        icon: "check-circle"
      }
    ],
    title: "Android"
  },
  desktop: {
    browser: "Chrome or Edge",
    id: "desktop",
    note: (
      <>
        On a Mac with Safari, choose <Key>File → Add to Dock</Key> instead.
      </>
    ),
    steps: [
      {
        content: (
          <>
            Look for the install icon <InlineIcon label="install" name="download" /> at the right
            end of the address bar.
          </>
        ),
        icon: "monitor"
      },
      {
        content: (
          <>
            Click it, then choose <Key>Install</Key>.
          </>
        ),
        icon: "download"
      },
      {
        content: <>LinkDish opens in its own window. Find it with your other apps.</>,
        icon: "check-circle"
      }
    ],
    title: "Computer"
  },
  ios: {
    browser: "Safari",
    id: "ios",
    note: (
      <>
        In Chrome or another browser? Look for <Key>Share</Key>, then <Key>Add to Home Screen</Key>.
      </>
    ),
    steps: [
      {
        content: (
          <>
            Tap Share <InlineIcon label="share" name="share-up" /> in Safari&apos;s toolbar.
          </>
        ),
        icon: "share-up"
      },
      {
        content: (
          <>
            Scroll down and tap <Key>Add to Home Screen</Key>.
          </>
        ),
        icon: "plus-circle"
      },
      {
        content: (
          <>
            Tap <Key>Add</Key>. LinkDish lands on your home screen.
          </>
        ),
        icon: "check-circle"
      }
    ],
    title: "iPhone and iPad"
  }
};
