import React, { useState, useEffect } from "react";

import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { Icon } from "../../components/Icon";
import { isStandaloneMode } from "../../platform/detect-installation";
import { isIos } from "../../platform/detect-ios";
import "./InstallPrompt.css";

// Interface for beforeinstallprompt event
interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  readonly userChoice: Promise<{
    outcome: "accepted" | "dismissed";
    platform: string;
  }>;
  prompt(): Promise<void>;
}

export const InstallPrompt: React.FC = () => {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [showPrompt, setShowPrompt] = useState(false);
  const [isDismissed, setIsDismissed] = useState(false);

  useEffect(() => {
    if (isStandaloneMode()) {
      return;
    }

    const hasExtracted = localStorage.getItem("linkdish:web:has-extracted-recipe") === "true";
    if (!hasExtracted) {
      // Only show install education after user has successfully extracted at least one recipe
      return;
    }

    const dismissed = localStorage.getItem("linkdish:web:install-prompt-dismissed") === "true";
    if (dismissed) {
      setIsDismissed(true);
      return;
    }

    // Always show prompt for iOS manual flow if not standalone
    if (isIos()) {
      setShowPrompt(true);
    }

    const handleBeforeInstallPrompt = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
      setShowPrompt(true);
    };

    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);

    return () => {
      window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    };
  }, []);

  const handleInstallClick = async () => {
    if (!deferredPrompt) return;

    const promptEvent = deferredPrompt;
    setDeferredPrompt(null);

    try {
      await promptEvent.prompt();
      const { outcome } = await promptEvent.userChoice;

      if (outcome === "accepted") {
        setShowPrompt(false);
      }
    } catch (err) {
      console.warn("Install prompt failed:", err);
    } finally {
      setShowPrompt(false);
    }
  };

  const handleDismiss = () => {
    localStorage.setItem("linkdish:web:install-prompt-dismissed", "true");
    setIsDismissed(true);
    setShowPrompt(false);
  };

  if (!showPrompt || isDismissed) {
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
        {isIos() ? (
          <p className="install-ios-instructions">
            Tap <span className="share-icon">⎙</span> (Share) in Safari, then choose{" "}
            <strong>Add to Home Screen</strong>.
          </p>
        ) : (
          <Button variant="primary" onClick={handleInstallClick} disabled={!deferredPrompt}>
            Install App
          </Button>
        )}
      </div>
    </Card>
  );
};
