import React, { useState } from "react";

import { trackWebEvent } from "../../analytics/client";
import { BrandMark } from "../../components/BrandMark";
import { Button } from "../../components/Button";
import { Icon } from "../../components/Icon";
import { IconButton } from "../../components/IconButton";
import { useInstallPrompt } from "../../platform/install-prompt";
import { safeGetItem, safeSetItem } from "../../platform/safe-storage";

import "./InstallPrompt.css";

const HAS_EXTRACTED_STORAGE_KEY = "linkdish:web:has-extracted-recipe";
const DISMISSED_STORAGE_KEY = "linkdish:web:install-prompt-dismissed";

/**
 * A gentle install nudge shown on the import screen once someone has saved a recipe. Uses the
 * install event captured at boot (platform/install-prompt), so it works even though this card
 * mounts long after the browser offered the install.
 */
export const InstallPrompt: React.FC = () => {
  const { canInstall, isInstalled, platform, promptInstall } = useInstallPrompt();
  const [isDismissed, setIsDismissed] = useState(
    () => safeGetItem(DISMISSED_STORAGE_KEY) === "true"
  );
  const [hasPrompted, setHasPrompted] = useState(false);
  // Only show install education after the user has successfully extracted at least one recipe.
  const [hasExtracted] = useState(() => safeGetItem(HAS_EXTRACTED_STORAGE_KEY) === "true");
  const isIosDevice = platform === "ios";

  const handleInstallClick = async () => {
    setHasPrompted(true);
    trackWebEvent({
      eventName: "web_install_cta_clicked",
      routeOrScreen: window.location.pathname,
      properties: { platform, surface: "install_prompt" }
    });
    await promptInstall();
  };

  const handleDismiss = () => {
    safeSetItem(DISMISSED_STORAGE_KEY, "true");
    setIsDismissed(true);
  };

  const showPrompt =
    !isInstalled && hasExtracted && !isDismissed && !hasPrompted && (isIosDevice || canInstall);

  if (!showPrompt) {
    return null;
  }

  return (
    <section aria-labelledby="install-prompt-title" className="install-prompt animate-fade-in">
      <span className="install-prompt-mark" aria-hidden="true">
        <BrandMark size={30} />
      </span>
      <div className="install-prompt-copy">
        <h2 className="install-prompt-title" id="install-prompt-title">
          Add LinkDish to your home screen
        </h2>
        {isIosDevice ? (
          <p className="install-prompt-desc">
            Tap Share{" "}
            <span className="install-prompt-glyph" role="img" aria-label="share">
              <Icon name="share-up" size={14} strokeWidth={2.2} />
            </span>{" "}
            in Safari, then <strong>Add to Home Screen</strong>.
          </p>
        ) : (
          <p className="install-prompt-desc">
            {platform === "android"
              ? "Open it like an app and share recipes straight into LinkDish."
              : "Open it in its own window, right from your dock or taskbar."}
          </p>
        )}
      </div>
      {isIosDevice ? null : (
        <Button
          className="install-prompt-action"
          disabled={!canInstall}
          icon="smartphone-download"
          onClick={() => void handleInstallClick()}
          size="sm"
        >
          Install app
        </Button>
      )}
      <IconButton
        aria-label="Dismiss install tip"
        className="install-prompt-close"
        icon="x"
        onClick={handleDismiss}
        size="sm"
      />
    </section>
  );
};
