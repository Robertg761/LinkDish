import React from "react";

import { PageHeader } from "./PageHeader";

import "./PrivacyPage.css";

// A summary only, with no date of its own: linkdish.ca/privacy is the one policy text.
export const PrivacyPage: React.FC = () => {
  return (
    <div className="privacy-page container page-enter">
      <PageHeader className="privacy-header" eyebrow="Privacy" title="Your privacy" />

      <article className="privacy-card">
        <div className="privacy-content">
          <p className="privacy-intro">
            LinkDish handles the recipes, links and images you give it, plus the account and plan
            details it needs to run. The full policy explains what is handled and why.
          </p>
          <section className="privacy-section">
            <h2>Read the details</h2>
            <p>
              <a href="https://linkdish.ca/privacy/">Privacy Policy</a>
              {" · "}
              <a href="https://linkdish.ca/terms/">Terms of Service</a>
              {" · "}
              <a href="https://linkdish.ca/delete-account/">Delete your account</a>
              {" · "}
              <a href="https://github.com/Robertg761/LinkDish/blob/main/THIRD_PARTY_NOTICES.md">
                Open source licences
              </a>
            </p>
          </section>
          <section className="privacy-section">
            <h2>Questions</h2>
            <p>
              Email <a href="mailto:support@linkdish.ca">support@linkdish.ca</a>.
            </p>
          </section>
        </div>
      </article>
    </div>
  );
};
