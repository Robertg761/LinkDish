import type { IconName } from "../../components/Icon";

export type SettingsSectionId = "appearance" | "units" | "cooking" | "your-data" | "more";

export const SETTINGS_SECTIONS: ReadonlyArray<{
  id: SettingsSectionId;
  label: string;
  icon: IconName;
}> = [
  { id: "appearance", label: "Appearance", icon: "sun" },
  { id: "units", label: "Units", icon: "scale" },
  { id: "cooking", label: "Cooking", icon: "chef-hat" },
  { id: "your-data", label: "Your data", icon: "shield-check" },
  { id: "more", label: "More", icon: "more-horizontal" }
];

/** DOM id of a section; `/settings#your-data` deep-links to it. */
export const settingsSectionElementId = (id: SettingsSectionId): string => `settings-${id}`;

export const isSettingsSectionId = (value: string): value is SettingsSectionId =>
  SETTINGS_SECTIONS.some((section) => section.id === value);
