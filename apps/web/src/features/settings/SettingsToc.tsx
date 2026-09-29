import React, { useEffect, useState } from "react";

import { Icon } from "../../components/Icon";

import { SETTINGS_SECTIONS, settingsSectionElementId } from "./settings-sections";

import type { SettingsSectionId } from "./settings-sections";

const prefersReducedMotion = (): boolean => {
  try {
    return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  } catch {
    return false;
  }
};

/** Scrolls a settings section into view and moves focus to its heading. */
export const scrollToSettingsSection = (id: SettingsSectionId): void => {
  const section = document.getElementById(settingsSectionElementId(id));

  if (!section) {
    return;
  }

  section.scrollIntoView?.({
    behavior: prefersReducedMotion() ? "auto" : "smooth",
    block: "start"
  });
  section.querySelector<HTMLElement>(".settings-section-title")?.focus({ preventScroll: true });
};

/** The desktop "On this page" list; highlights the section being read. */
export const SettingsToc: React.FC = () => {
  const [active, setActive] = useState<SettingsSectionId>("appearance");

  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") {
      return undefined;
    }

    const visible = new Map<SettingsSectionId, number>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset.settingsSection as SettingsSectionId;

          if (entry.isIntersecting) {
            visible.set(id, entry.boundingClientRect.top);
          } else {
            visible.delete(id);
          }
        }

        const first = SETTINGS_SECTIONS.find((section) => visible.has(section.id));

        if (first) {
          setActive(first.id);
        }
      },
      { rootMargin: "-15% 0px -55% 0px" }
    );

    for (const section of SETTINGS_SECTIONS) {
      const element = document.getElementById(settingsSectionElementId(section.id));

      if (element) {
        observer.observe(element);
      }
    }

    return () => observer.disconnect();
  }, []);

  return (
    <nav aria-label="Settings sections" className="settings-toc">
      <p className="settings-toc-title">On this page</p>
      <ul className="settings-toc-list">
        {SETTINGS_SECTIONS.map((section) => (
          <li key={section.id}>
            <a
              aria-current={active === section.id ? "location" : undefined}
              className={`settings-toc-link${active === section.id ? " is-active" : ""}`}
              href={`#${section.id}`}
              onClick={(event) => {
                event.preventDefault();
                setActive(section.id);
                scrollToSettingsSection(section.id);
              }}
            >
              <Icon name={section.icon} size={16} />
              {section.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
};
