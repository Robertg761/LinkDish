import React, { useState } from "react";

import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { Icon } from "../../components/Icon";
import { useInstallPrompt } from "../../platform/install-prompt";
import { safeGetItem, safeSetItem } from "../../platform/safe-storage";
import "./InstallPrompt.css";

const HAS_EXTRACTED_STORAGE_KEY = "linkdish:web:has-extracted-recipe";
const DISMISSED_STORAGE_KEY = "linkdish:web:install-prompt-dismissed";

export const InstallPrompt: React.FC = () => {
  // The browser's install event is captured at boot (see platform/install-prompt), so it is
  // available here even though this card mounts long after the event fired.
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
    <Card className="install-prompt-card animate-fade-in" variant="subtle">
      <div className="install-prompt-header">
        <Icon
          name="cellphone-arrow-down"
          size={28}
          color="var(--color-accent)"
          className="install-prompt-icon"
        />
        <div className="install-prompt-text-container">
          <h4 className="install-prompt-title">Add LinkDish to Home Screen</h4>
          <p className="install-prompt-desc">
            Open LinkDish from your home screen and keep saved recipes close.
          </p>
        </div>
        <button
          className="install-prompt-close"
          onClick={handleDismiss}
          aria-label="Dismiss prompt"
        >
          <Icon name="close" size={20} />
        </button>
      </div>

      <div className="install-prompt-actions">
        {isIosDevice ? (
          <p className="install-ios-instructions">
            Tap <span className="share-icon">⎙</span> (Share) in Safari, then choose{" "}
            <strong>Add to Home Screen</strong>.
          </p>
        ) : (
          <Button variant="primary" onClick={handleInstallClick} disabled={!canInstall}>
            Install App
          </Button>
        )}
      </div>
    </Card>
  );
};
