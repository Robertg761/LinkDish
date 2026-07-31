import React from "react";

import "./SupportPage.css";

export const SupportPage: React.FC = () => {
  return (
    <div className="support-page container page-enter">
      <article className="support-card">
        <h1 className="support-title">Customer Support</h1>
        <p className="support-intro">We are here to help you get the most out of LinkDish.</p>

        <div className="support-content">
          <p>
            If you encounter problems extracting recipes, have questions about your account, or want
            to suggest new features, please contact us.
          </p>
          <section className="support-section">
            <h2>Contact Information</h2>
            <p>
              Email:{" "}
              <a href="mailto:support@linkdish.ca" className="support-link">
                support@linkdish.ca
              </a>
            </p>
          </section>
          <p>
            Response Time: We typically reply within 24 hours.
          </p>
        </div>
      </article>
    </div>
  );
};
