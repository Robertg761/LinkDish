import React, { useEffect } from "react";
import { Link, useLocation } from "react-router-dom";

import { Icon } from "../../components/Icon";
import { PageHeader } from "../../components/PageHeader";
import { SegmentedControl } from "../../components/SegmentedControl";
import { Switch } from "../../components/Switch";
import { useMediaQuery } from "../../lib/use-media-query";
import { setPreference, usePreferences } from "../../preferences/preferences-store";
import { COOK_TEXT_SIZE_OPTIONS } from "../cook-mode/cook-text-size";

import { isSettingsSectionId, settingsSectionElementId } from "./settings-sections";
import { scrollToSettingsSection, SettingsToc } from "./SettingsToc";
import { YourDataSection } from "./YourDataSection";

import type { SettingsSectionId } from "./settings-sections";
import type { IconName } from "../../components/Icon";
import type { SegmentedOption } from "../../components/SegmentedControl";
import type {
  ThemePreference,
  UnitsPreference,
  WeekStartsOn
} from "../../preferences/preferences-store";

import "./SettingsPage.css";

/** The "On this page" list needs room beside the 720px column (rail + column + list). */
const SETTINGS_TOC_MEDIA_QUERY = "(min-width: 1200px)";

const THEME_OPTIONS: ReadonlyArray<SegmentedOption<ThemePreference>> = [
  { value: "system", label: "System", icon: "monitor" },
  { value: "light", label: "Light", icon: "sun" },
  { value: "dark", label: "Dark", icon: "moon" }
];

const UNIT_OPTIONS: ReadonlyArray<SegmentedOption<UnitsPreference>> = [
  { value: "original", label: "Original" },
  { value: "us", label: "US" },
  { value: "metric", label: "Metric" }
];

const WEEK_START_OPTIONS: ReadonlyArray<SegmentedOption<WeekStartsOn>> = [
  { value: 0, label: "Sunday" },
  { value: 1, label: "Monday" }
];

const UNIT_HINTS: Record<UnitsPreference, string> = {
  original: "Amounts appear exactly as the recipe wrote them.",
  us: "Converts to cups, tablespoons, ounces and °F where it can.",
  metric: "Converts to grams, millilitres and °C where it can."
};

const LINKS: ReadonlyArray<{ to: string; label: string; description: string; icon: IconName }> = [
  {
    to: "/install",
    label: "Install LinkDish",
    description: "Add it to your home screen or dock",
    icon: "smartphone-download"
  },
  {
    to: "/support",
    label: "Help & support",
    description: "Questions, bugs and ideas",
    icon: "help-circle"
  },
  {
    to: "/privacy",
    label: "Privacy",
    description: "What LinkDish stores and why",
    icon: "shield-check"
  }
];

interface SettingsSectionProps {
  id: SettingsSectionId;
  title: string;
  description?: string;
  /** Render children as-is (several cards) instead of inside one settings card. */
  plain?: boolean | undefined;
  children: React.ReactNode;
}

const SettingsSection: React.FC<SettingsSectionProps> = ({
  id,
  title,
  description,
  plain = false,
  children
}) => (
  <section
    aria-labelledby={`${id}-title`}
    className="settings-section"
    data-settings-section={id}
    id={settingsSectionElementId(id)}
  >
    <div className="settings-section-heading">
      <h2 className="settings-section-title" id={`${id}-title`} tabIndex={-1}>
        {title}
      </h2>
      {description ? <p className="settings-section-description">{description}</p> : null}
    </div>
    {plain ? children : <div className="settings-card">{children}</div>}
  </section>
);

const SettingsRow: React.FC<{
  label: string;
  hint?: React.ReactNode;
  children: React.ReactNode;
}> = ({ label, hint, children }) => (
  <div className="settings-row">
    <div className="settings-row-copy">
      <span className="settings-row-label">{label}</span>
      {hint ? <span className="settings-row-hint">{hint}</span> : null}
    </div>
    <div className="settings-row-control">{children}</div>
  </div>
);

/**
 * The section a URL fragment names. Fragments come from links anyone can write: one that isn't
 * valid percent-encoding (e.g. "#%") names no section rather than breaking the page.
 */
const readHashTarget = (hash: string): string => {
  const raw = hash.replace(/^#/u, "");

  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
};

export const SettingsPage: React.FC = () => {
  const preferences = usePreferences();
  const { hash } = useLocation();
  const showToc = useMediaQuery(SETTINGS_TOC_MEDIA_QUERY);

  // /settings#your-data (and the other section names) jump straight to that section.
  useEffect(() => {
    const target = readHashTarget(hash);

    if (isSettingsSectionId(target)) {
      const frame = window.requestAnimationFrame(() => scrollToSettingsSection(target));
      return () => window.cancelAnimationFrame(frame);
    }

    return undefined;
  }, [hash]);

  return (
    <div className="settings-layout page-enter">
      <div className="settings-page">
        <PageHeader
          subtitle="Make LinkDish feel like your own kitchen. Changes save on this device right away."
          title="Settings"
        />

        <SettingsSection id="appearance" title="Appearance">
          <SettingsRow hint="System follows your device's light or dark setting." label="Theme">
            <SegmentedControl
              aria-label="Theme"
              fullWidth
              onChange={(value) => setPreference("theme", value)}
              options={THEME_OPTIONS}
              value={preferences.theme}
            />
          </SettingsRow>
        </SettingsSection>

        <SettingsSection id="units" title="Units">
          <SettingsRow hint={UNIT_HINTS[preferences.units]} label="Measurements">
            <SegmentedControl
              aria-label="Measurements"
              fullWidth
              onChange={(value) => setPreference("units", value)}
              options={UNIT_OPTIONS}
              value={preferences.units}
            />
          </SettingsRow>
        </SettingsSection>

        <SettingsSection id="cooking" title="Cooking">
          <Switch
            checked={preferences.keepScreenAwake}
            description="Stops the screen from dimming while cook mode is open."
            label="Keep screen awake"
            onChange={(checked) => setPreference("keepScreenAwake", checked)}
          />
          <div className="settings-divider" />
          <SettingsRow label="Cook mode text size">
            <SegmentedControl
              aria-label="Cook mode text size"
              fullWidth
              onChange={(value) => setPreference("cookTextSize", value)}
              options={COOK_TEXT_SIZE_OPTIONS}
              value={preferences.cookTextSize}
            />
          </SettingsRow>
          <p
            aria-hidden="true"
            className={`settings-text-preview settings-text-preview-${preferences.cookTextSize}`}
          >
            Whisk the eggs until pale and fluffy.
          </p>
          <div className="settings-divider" />
          <SettingsRow hint="Used by the meal plan." label="Week starts on">
            <SegmentedControl
              aria-label="Week starts on"
              fullWidth
              onChange={(value) => setPreference("weekStartsOn", value)}
              options={WEEK_START_OPTIONS}
              value={preferences.weekStartsOn}
            />
          </SettingsRow>
        </SettingsSection>

        <SettingsSection
          description="Back up your cookbook, bring recipes over from other apps, and see what's stored on this device."
          id="your-data"
          plain
          title="Your data"
        >
          <YourDataSection />
        </SettingsSection>

        <SettingsSection id="more" title="More">
          <nav aria-label="More settings" className="settings-links">
            {LINKS.map((link) => (
              <Link className="settings-link" key={link.to} to={link.to}>
                <span className="settings-link-icon">
                  <Icon name={link.icon} size={19} />
                </span>
                <span className="settings-link-copy">
                  <span className="settings-link-label">{link.label}</span>
                  <span className="settings-link-description">{link.description}</span>
                </span>
                <Icon name="chevron-right" size={18} className="settings-link-chevron" />
              </Link>
            ))}
          </nav>
        </SettingsSection>
      </div>
      {showToc ? (
        <aside className="settings-toc-column">
          <SettingsToc />
        </aside>
      ) : null}
    </div>
  );
};
