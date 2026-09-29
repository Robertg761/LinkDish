import React, { useEffect, useRef, useState } from "react";

import { trackWebEvent } from "../../analytics/client";
import { BrandMark } from "../../components/BrandMark";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { Icon } from "../../components/Icon";
import { PageHeader } from "../../components/PageHeader";
import { useToast } from "../../components/Toast";
import { useDocumentTitle } from "../../lib/use-document-title";
import { useInstallPrompt } from "../../platform/install-prompt";
import { copyText } from "../household/share-invite";

import {
  BOOKMARKLET_HREF,
  PLATFORM_GUIDES,
  PLAY_STORE_URL,
  type PlatformGuide
} from "./install-content";

import type { InstallPlatform } from "../../platform/install-prompt";

import "./InstallPage.css";

const PLATFORM_ORDER: ReadonlyArray<InstallPlatform> = ["ios", "android", "desktop"];

const GuideSteps: React.FC<{ guide: PlatformGuide }> = ({ guide }) => (
  <>
    <ol className="install-steps">
      {guide.steps.map((step, index) => (
        <li className="install-step" key={index}>
          <span className="install-step-number num" aria-hidden="true">
            {index + 1}
          </span>
          <span className="install-step-text">{step.content}</span>
        </li>
      ))}
    </ol>
    {guide.note ? <p className="install-guide-note">{guide.note}</p> : null}
  </>
);

/** A draggable "Save to LinkDish" link. Its javascript: href is set on the DOM node directly. */
export const BookmarkletLink: React.FC<{ onClickInstead: () => void }> = ({ onClickInstead }) => {
  const linkRef = useRef<HTMLAnchorElement>(null);

  useEffect(() => {
    linkRef.current?.setAttribute("href", BOOKMARKLET_HREF);
  }, []);

  return (
    <a
      className="install-bookmarklet"
      onClick={(event) => {
        // Clicking it here would just import this page; it's meant to be dragged.
        event.preventDefault();
        onClickInstead();
      }}
      ref={linkRef}
      title="Drag me to your bookmarks bar"
    >
      <Icon name="bookmark-plus" size={18} />
      Save to LinkDish
    </a>
  );
};

export const InstallPage: React.FC = () => {
  useDocumentTitle("Install LinkDish");
  const { canInstall, isInstalled, platform, promptInstall } = useInstallPrompt();
  const { showToast } = useToast();
  const [installing, setInstalling] = useState(false);
  const guide = PLATFORM_GUIDES[platform];
  const otherGuides = PLATFORM_ORDER.filter((id) => id !== platform).map(
    (id) => PLATFORM_GUIDES[id]
  );

  const install = async () => {
    setInstalling(true);
    trackWebEvent({
      eventName: "web_install_cta_clicked",
      routeOrScreen: "/install",
      properties: { platform, surface: "install_page" }
    });
    const outcome = await promptInstall();
    setInstalling(false);

    if (outcome === "accepted") {
      showToast({ message: "LinkDish is installing", tone: "success" });
    }
  };

  const copyBookmarklet = async () => {
    showToast(
      (await copyText(BOOKMARKLET_HREF))
        ? { message: "Bookmarklet copied", tone: "success" }
        : { message: "Couldn't copy. Try dragging the button instead.", tone: "danger" }
    );
  };

  return (
    <div className="install-page container page-enter">
      <PageHeader
        accent="home screen"
        eyebrow="Install"
        subtitle="Opens like an app, keeps your saved recipes handy offline, and saves recipes from anywhere you browse."
        title="LinkDish on your"
      />

      {isInstalled ? (
        <Card className="install-hero install-hero-done" variant="raised">
          <span className="install-hero-icon install-hero-icon-done" aria-hidden="true">
            <Icon name="check" size={28} strokeWidth={2.6} />
          </span>
          <div className="install-hero-copy">
            <h2>You&apos;re all set</h2>
            <p>LinkDish is installed on this device. Open it from your home screen or app list.</p>
          </div>
        </Card>
      ) : canInstall ? (
        <Card className="install-hero" variant="raised">
          <span className="install-hero-icon" aria-hidden="true">
            <BrandMark size={40} />
          </span>
          <div className="install-hero-copy">
            <h2>Install in one tap</h2>
            <p>Free, no app store needed, and it updates itself.</p>
          </div>
          <Button
            icon="smartphone-download"
            loading={installing}
            onClick={() => void install()}
            size="lg"
          >
            Install LinkDish
          </Button>
        </Card>
      ) : (
        <Card className="install-guide" variant="raised">
          <div className="install-guide-head">
            <span className="install-hero-icon" aria-hidden="true">
              <BrandMark size={36} />
            </span>
            <div>
              <h2 className="install-guide-title">
                {guide.title} <span className="install-guide-browser">· {guide.browser}</span>
              </h2>
              <p className="install-guide-lede">Three quick steps, about ten seconds.</p>
            </div>
          </div>
          <GuideSteps guide={guide} />
        </Card>
      )}

      {!isInstalled ? (
        <details className="install-other">
          <summary>
            <span>Installing on another device?</span>
            <Icon className="install-other-chevron" name="chevron-down" size={20} />
          </summary>
          <div className="install-other-body">
            {(canInstall ? PLATFORM_ORDER.map((id) => PLATFORM_GUIDES[id]) : otherGuides).map(
              (other) => (
                <section className="install-other-guide" key={other.id}>
                  <h3>
                    {other.title} <span>· {other.browser}</span>
                  </h3>
                  <GuideSteps guide={other} />
                </section>
              )
            )}
          </div>
        </details>
      ) : null}

      <section aria-labelledby="install-save-title" className="install-section">
        <div className="install-section-heading">
          <h2 id="install-save-title">Save recipes from anywhere</h2>
          <p>Found something good? Send it to LinkDish without copying and pasting.</p>
        </div>

        <Card className="install-bookmarklet-card" variant="default">
          <div className="install-card-title">
            <span className="install-card-icon" aria-hidden="true">
              <Icon name="bookmark-plus" size={20} />
            </span>
            <div>
              <h3>The Save to LinkDish button</h3>
              <p>For Chrome, Edge, Safari and Firefox on a computer.</p>
            </div>
          </div>
          <div className="install-bookmarklet-demo">
            <BookmarkletLink
              onClickInstead={() =>
                showToast({ message: "Drag the button to your bookmarks bar to use it." })
              }
            />
            <span className="install-bookmarklet-arrow" aria-hidden="true">
              <Icon name="arrow-up" size={18} />
              Drag it to your bookmarks bar
            </span>
          </div>
          <ol className="install-mini-steps">
            <li>Drag the button above onto your bookmarks bar.</li>
            <li>On any recipe page, click it.</li>
            <li>LinkDish opens and starts reading the recipe.</li>
          </ol>
          <p className="install-fineprint">
            On a phone or tablet? Copy the button&apos;s code, bookmark any page, then edit that
            bookmark and paste the code in as its address.{" "}
            <button
              className="install-text-button"
              onClick={() => void copyBookmarklet()}
              type="button"
            >
              Copy the code
            </button>
          </p>
        </Card>

        <Card className="install-share-card" variant="default">
          <div className="install-card-title">
            <span className="install-card-icon" aria-hidden="true">
              <Icon name="share-up" size={20} />
            </span>
            <div>
              <h3>Share to LinkDish</h3>
              <p>Send links straight from other apps.</p>
            </div>
          </div>
          <ul className="install-share-tips">
            <li className={platform === "android" ? "is-yours" : undefined}>
              <strong>Android</strong>
              <span>
                Install LinkDish, then tap <em>Share</em> in Chrome, YouTube or Instagram and pick
                LinkDish. The recipe starts importing right away.
              </span>
            </li>
            <li className={platform === "ios" ? "is-yours" : undefined}>
              <strong>iPhone and iPad</strong>
              <span>
                Web apps can&apos;t join the iOS share menu yet. Copy the link and paste it into Add
                recipe, or use the Save to LinkDish bookmark in Safari.
              </span>
            </li>
            <li className={platform === "desktop" ? "is-yours" : undefined}>
              <strong>Computer</strong>
              <span>Use the Save to LinkDish button on any recipe page.</span>
            </li>
          </ul>
          <p className="install-fineprint">
            Prefer an app store?{" "}
            <a href={PLAY_STORE_URL} rel="noreferrer" target="_blank">
              Get LinkDish for Android on Google Play
            </a>
            .
          </p>
        </Card>
      </section>
    </div>
  );
};
