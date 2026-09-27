import React from "react";
import { Link } from "react-router-dom";

import { Icon } from "../../components/Icon";
import { PageHeader } from "../../components/PageHeader";
import { SegmentedControl } from "../../components/SegmentedControl";
import { Switch } from "../../components/Switch";
import { setPreference, usePreferences } from "../../preferences/preferences-store";

import type { IconName } from "../../components/Icon";
import type { SegmentedOption } from "../../components/SegmentedControl";
import type {
  CookTextSize,
  ThemePreference,
  UnitsPreference,
  WeekStartsOn
} from "../../preferences/preferences-store";

import "./SettingsPage.css";

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

const TEXT_SIZE_OPTIONS: ReadonlyArray<SegmentedOption<CookTextSize>> = [
  { value: "md", label: "Regular" },
  { value: "lg", label: "Large" },
  { value: "xl", label: "Largest" }
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
  id: string;
  title: string;
  description?: string;
  children: React.ReactNode;
}

const SettingsSection: React.FC<SettingsSectionProps> = ({ id, title, description, children }) => (
  <section aria-labelledby={`${id}-title`} className="settings-section" data-settings-section={id}>
    <div className="settings-section-heading">
      <h2 className="settings-section-title" id={`${id}-title`}>
        {title}
      </h2>
      {description ? <p className="settings-section-description">{description}</p> : null}
    </div>
    <div className="settings-card">{children}</div>
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

export const SettingsPage: React.FC = () => {
  const preferences = usePreferences();

  return (
    <div className="settings-page container page-enter">
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
            options={TEXT_SIZE_OPTIONS}
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
        description="Your personal recipes are saved in this browser on this device."
        id="your-data"
        title="Your data"
      >
        <div className="settings-data-placeholder">
          <Icon name="cloud-upload" size={20} />
          <p>Export, import and backups are coming soon.</p>
        </div>
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
  );
};
