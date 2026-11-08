import React from "react";
import { act, create } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getItem: vi.fn(),
  setItem: vi.fn(),
  openURL: vi.fn(),
  alert: vi.fn()
}));
vi.mock("../../theme/tokens", () => ({ appColors: { border: "#ddd2c3" } }));
vi.mock("@react-native-async-storage/async-storage", () => ({ default: mocks }));
vi.mock("@linkdish/ui", () => ({
  AppButton: ({ label, onPress }: { label: string; onPress: () => void }) =>
    React.createElement("button", { onPress, label }, label),
  AppText: ({ children }: { children: React.ReactNode }) =>
    React.createElement("text", null, children),
  AppSurface: ({ children }: { children: React.ReactNode }) =>
    React.createElement("surface", null, children)
}));
vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  Alert: { alert: mocks.alert },
  Linking: { openURL: mocks.openURL },
  Modal: ({ visible, children }: { visible: boolean; children: React.ReactNode }) =>
    visible ? React.createElement("modal", null, children) : null,
  View: ({ children }: { children: React.ReactNode }) =>
    React.createElement("view", null, children),
  ScrollView: ({ children }: { children: React.ReactNode }) =>
    React.createElement("scroll", null, children),
  StyleSheet: { create: <T,>(styles: T) => styles }
}));

import { AppLegalLinks } from "../../components/AppLegalLinks";

import { AI_CONSENT_STORAGE_KEY, requireAiConsent, reviewAiConsent } from "./ai-consent";
import { AiConsentGate } from "./AiConsentGate";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const press = (renderer: ReturnType<typeof create>, label: string) => {
  const props = renderer.root.findByProps({ label }).props as { onPress: () => void };
  props.onPress();
};

describe("AI consent and subscription controls", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getItem.mockResolvedValue(null);
    mocks.setItem.mockResolvedValue(undefined);
    mocks.openURL.mockResolvedValue(undefined);
  });

  it("waits for onboarding, offers privacy without accepting, and saves explicit acceptance", async () => {
    let renderer!: ReturnType<typeof create>;
    let permission!: Promise<void>;
    await act(() => {
      renderer = create(<AiConsentGate blocked />);
    });
    await act(async () => {
      permission = requireAiConsent();
      await Promise.resolve();
    });
    expect(renderer.toJSON()).toBeNull();
    expect(mocks.setItem).not.toHaveBeenCalled();
    await act(() => {
      renderer.update(<AiConsentGate />);
    });
    expect(JSON.stringify(renderer.toJSON())).toContain("Google Gemini");
    await act(() => {
      press(renderer, "Privacy policy");
    });
    expect(mocks.openURL).toHaveBeenCalledWith("https://linkdish.ca/privacy/");
    expect(mocks.setItem).not.toHaveBeenCalled();
    await act(async () => {
      press(renderer, "Allow and continue");
      await permission;
    });
    expect(mocks.setItem).toHaveBeenCalledWith(AI_CONSENT_STORAGE_KEY, "allowed");
    expect(renderer.toJSON()).toBeNull();
    await act(() => {
      renderer.unmount();
    });
  });

  it("lets the user change an existing grant to a denial", async () => {
    mocks.getItem.mockResolvedValue("allowed");
    let renderer!: ReturnType<typeof create>;
    let review!: Promise<void>;
    await act(() => {
      renderer = create(<AiConsentGate />);
    });
    await act(async () => {
      await requireAiConsent();
    });
    expect(renderer.toJSON()).toBeNull();
    await act(() => {
      review = reviewAiConsent();
    });
    await act(async () => {
      press(renderer, "Don't allow");
      await review;
    });
    expect(mocks.setItem).toHaveBeenCalledWith(AI_CONSENT_STORAGE_KEY, "denied");
    await act(() => {
      renderer.unmount();
    });
  });

  it("opens Apple's subscription management page and explains a failed link", async () => {
    let renderer!: ReturnType<typeof create>;
    await act(() => {
      renderer = create(<AppLegalLinks />);
    });
    await act(() => {
      press(renderer, "Manage subscription");
    });
    expect(mocks.openURL).toHaveBeenCalledWith("https://apps.apple.com/account/subscriptions");
    mocks.openURL.mockRejectedValueOnce(new Error("Cannot open"));
    await act(async () => {
      press(renderer, "Manage subscription");
      await Promise.resolve();
    });
    expect(mocks.alert).toHaveBeenCalledWith(
      "Unable to open link",
      expect.stringContaining("https://apps.apple.com/account/subscriptions")
    );
    await act(() => {
      renderer.unmount();
    });
  });
});
