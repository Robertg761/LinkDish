import React from "react";
import { Link } from "react-router-dom";

import { getButtonClassName } from "./Button";
import { Icon } from "./Icon";
import { PageHeader } from "./PageHeader";

import type { IconName } from "./Icon";

import "./SupportPage.css";

const SUPPORT_EMAIL = "support@linkdish.ca";

const TOPICS: ReadonlyArray<{ to: string; icon: IconName; title: string; body: string }> = [
  {
    body: "Imports, saved recipes, cancelling and what each plan includes.",
    icon: "crown",
    title: "Plans and billing",
    to: "/pricing"
  },
  {
    body: "Invites, joining with a code and sharing a shopping list.",
    icon: "users",
    title: "Households",
    to: "/household"
  },
  {
    body: "Home screen install and the Save to LinkDish button.",
    icon: "smartphone-download",
    title: "Install and save from anywhere",
    to: "/install"
  },
  {
    body: "What LinkDish stores, and how to delete your account.",
    icon: "shield-check",
    title: "Privacy and your data",
    to: "/privacy"
  }
];

export const SupportPage: React.FC = () => {
  return (
    <div className="support-page container page-enter">
      <PageHeader
        accent="help?"
        eyebrow="Support"
        subtitle="Problems importing a recipe, questions about your account, or an idea for LinkDish: we'd love to hear it."
        title="How can we"
      />

      <section aria-labelledby="support-contact-title" className="support-contact">
        <span className="support-contact-icon" aria-hidden="true">
          <Icon name="mail" size={24} />
        </span>
        <div className="support-contact-copy">
          <h2 id="support-contact-title">Email us</h2>
          <p>
            <a className="support-link" href={`mailto:${SUPPORT_EMAIL}`}>
              {SUPPORT_EMAIL}
            </a>
          </p>
          <p className="support-contact-note">We typically reply within 24 hours.</p>
        </div>
        <a
          className={getButtonClassName({ className: "support-contact-button" })}
          href={`mailto:${SUPPORT_EMAIL}`}
        >
          <Icon name="send" size={18} />
          Write to us
        </a>
      </section>

      <p className="support-tip">
        <Icon name="info" size={18} />
        <span>
          Reporting a recipe that didn&apos;t import? Include the link, so we can see what went
          wrong.
        </span>
      </p>

      <section aria-labelledby="support-topics-title" className="support-topics">
        <h2 className="support-topics-title" id="support-topics-title">
          Quick answers
        </h2>
        <nav aria-label="Help topics" className="support-topic-grid">
          {TOPICS.map((topic) => (
            <Link className="support-topic" key={topic.to} to={topic.to}>
              <span className="support-topic-icon" aria-hidden="true">
                <Icon name={topic.icon} size={20} />
              </span>
              <span className="support-topic-copy">
                <strong>{topic.title}</strong>
                <span>{topic.body}</span>
              </span>
              <Icon className="support-topic-chevron" name="chevron-right" size={18} />
            </Link>
          ))}
        </nav>
      </section>
    </div>
  );
};
