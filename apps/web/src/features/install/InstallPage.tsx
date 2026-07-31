import React from "react";

import { Card } from "../../components/Card";
import { isIos } from "../../platform/detect-ios";
import "./InstallPage.css";

export const InstallPage: React.FC = () => {
  return (
    <div className="install-page container page-enter">
      <header className="install-header">
        <p className="install-eyebrow">Install</p>
        <h1 className="install-title">Install LinkDish App</h1>
        <p className="install-subtitle">
          Add LinkDish to your device home screen for quick app-like access.
        </p>
      </header>

      <div className="install-steps-container">
        {/* iOS Safari */}
        <Card variant={isIos() ? "default" : "subtle"} className="install-step-card">
          <h2 className="step-card-title">iPhone & iPad (Safari)</h2>
          <ol className="step-list-ordered">
            <li>
              If LinkDish is already open in Safari, stay on this page. If you are in another
              browser, open this same page in Safari.
            </li>
            <li>
              Tap the <strong>Share</strong> button <span className="share-icon-large">⎙</span> in
              the navigation bar.
            </li>
            <li>
              Scroll down and tap <strong>Add to Home Screen</strong>.
            </li>
            <li>
              Tap <strong>Add</strong> in the top right corner.
            </li>
          </ol>
          <p className="step-card-footer-note">
            Note: Standalone web app installation on iOS requires Safari. Other browsers (Chrome,
            Firefox) on iOS do not support home-screen installation.
          </p>
        </Card>

        {/* Android Chrome */}
        <Card variant={!isIos() ? "default" : "subtle"} className="install-step-card">
          <h2 className="step-card-title">Android (Chrome)</h2>
          <ol className="step-list-ordered">
            <li>
              If LinkDish is already open in Chrome, stay on this page. If you are in another
              browser, open this same page in Chrome.
            </li>
            <li>Tap the menu icon (three vertical dots) in the top right corner.</li>
            <li>
              Tap <strong>Install app</strong> or <strong>Add to Home screen</strong>.
            </li>
            <li>Follow the on-screen prompts to confirm installation.</li>
          </ol>
        </Card>

        {/* Desktop Chrome / Edge */}
        <Card variant="subtle" className="install-step-card">
          <h2 className="step-card-title">Mac & Windows (Chrome/Edge/Brave)</h2>
          <ol className="step-list-ordered">
            <li>
              Stay on this LinkDish page in Chrome, Edge, or Brave.
            </li>
            <li>
              Look for the <strong>Install</strong> icon in the address bar (usually a computer
              monitor with a downward arrow).
            </li>
            <li>
              Click the icon and select <strong>Install</strong>.
            </li>
          </ol>
        </Card>
      </div>
    </div>
  );
};
