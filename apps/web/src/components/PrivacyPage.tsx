import React from "react";

import "./PrivacyPage.css";

export const PrivacyPage: React.FC = () => {
  return (
    <div className="privacy-page container page-enter">
      <article className="privacy-card">
        <h1 className="privacy-title">Privacy Policy</h1>
        <p className="privacy-updated">Last updated: July 10, 2026</p>

        <div className="privacy-content">
          <p>
            Welcome to LinkDish. We respect your privacy and are committed to protecting the
            information you share with us.
          </p>
          <section className="privacy-section">
            <h2>Information LinkDish handles</h2>
            <p>
              Recipe links and images you submit are sent to LinkDish's extraction service and its
              configured processing providers to produce structured recipe details. This may include
              source-page text, metadata, or video transcript details needed for the import.
            </p>
          </section>
          <section className="privacy-section">
            <h2>Saved recipes and households</h2>
            <p>
              Personal saved recipes are stored locally in your browser. Free includes up to 15
              personal saves and paid plans include unlimited saves. Clearing LinkDish site data
              deletes those local recipes. Recipes shared with a Family household are stored by
              LinkDish so active household members can access them.
            </p>
          </section>
          <section className="privacy-section">
            <h2>Accounts, purchases, and analytics</h2>
            <p>
              If you sign in, LinkDish handles your email, session or social-sign-in identity, plan
              status, and any household records. RevenueCat supplies purchase, subscription, and
              lifetime-access status. First-party analytics record product actions, import outcomes,
              performance, and sanitized errors, but not full recipe URLs, recipe content, uploaded
              images, raw page text, or prompts.
            </p>
          </section>
          <section className="privacy-section">
            <h2>Your choices</h2>
            <p>
              You can delete your LinkDish account from Account, remove local recipes, and stop
              submitting links or images at any time. Account deletion does not cancel a store or web
              subscription. See the full policy at{" "}
              <a href="https://linkdish.ca/privacy/">linkdish.ca/privacy</a> or contact{" "}
              <a href="mailto:support@linkdish.ca">support@linkdish.ca</a>.
            </p>
          </section>
        </div>
      </article>
    </div>
  );
};
