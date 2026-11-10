import React from "react";
import { Platform } from "react-native";
import { act, create } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  library: vi.fn(),
  camera: vi.fn(),
  permission: vi.fn(),
  prepare: vi.fn(),
  replace: vi.fn()
}));
vi.mock("expo-image-picker", () => ({
  launchImageLibraryAsync: mocks.library,
  launchCameraAsync: mocks.camera,
  requestCameraPermissionsAsync: mocks.permission
}));
vi.mock("expo-router", () => ({ router: { replace: mocks.replace } }));
vi.mock("../preparePickedImages", () => ({ preparePickedImages: mocks.prepare }));
vi.mock("../../../theme/tokens", () => ({
  appColors: { accent: "green", accentSoft: "lightgreen" }
}));
vi.mock("react-native", () => ({
  Platform: { OS: "android" },
  View: ({ children }: { children: React.ReactNode }) =>
    React.createElement("view", null, children),
  StyleSheet: { create: <T,>(styles: T) => styles }
}));
vi.mock("@linkdish/ui", () => ({
  AppText: ({ children }: { children: React.ReactNode }) =>
    React.createElement("text", null, children),
  AppButton: (props: { label: string; onPress: () => void; disabled?: boolean }) =>
    React.createElement("button", props, props.label)
}));
vi.mock("./UrlForm", () => ({
  UrlForm: (props: { onSubmit: (url: string) => void }) => React.createElement("url-form", props)
}));

import { getPendingImageImport } from "../pendingImageImports";

import { ImportRecovery, shouldOfferImportAlternative } from "./ImportRecovery";
import { UrlForm } from "./UrlForm";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const press = (renderer: ReturnType<typeof create>, label: string) => {
  const props = renderer.root.findByProps({ label }).props as { onPress: () => void };
  props.onPress();
};

describe("inline import recovery", () => {
  beforeEach(() => {
    Platform.OS = "android";
    vi.resetAllMocks();
    mocks.permission.mockResolvedValue({ granted: true });
    mocks.library.mockResolvedValue({
      canceled: false,
      assets: [{ uri: "file:///recipe.heic", width: 4000, height: 3000 }]
    });
    mocks.camera.mockResolvedValue({ canceled: true });
    mocks.prepare.mockResolvedValue([
      { mimeType: "image/jpeg", dataUrl: "data:image/jpeg;base64,aGVsbG8=" }
    ]);
  });

  it("shows supported link entry alongside permission-aware photo recovery on iPhone", async () => {
    Platform.OS = "ios";
    let renderer!: ReturnType<typeof create>;
    await act(() => {
      renderer = create(<ImportRecovery source="url" />);
    });
    expect(renderer.root.findByType(UrlForm)).toBeTruthy();
    expect(JSON.stringify(renderer.toJSON())).toContain("own or have permission to use");
    expect(JSON.stringify(renderer.toJSON())).toContain("A screenshot does not remove");
    await act(() => renderer.unmount());
  });

  it("opens the library directly and routes prepared photos through the normal import flow", async () => {
    let renderer!: ReturnType<typeof create>;
    await act(() => {
      renderer = create(<ImportRecovery source="url" />);
    });
    await act(async () => {
      press(renderer, "Upload recipe photo");
      await Promise.resolve();
    });
    expect(mocks.library).toHaveBeenCalledWith(
      expect.objectContaining({ selectionLimit: 4, base64: false })
    );
    expect(mocks.prepare).toHaveBeenCalledTimes(1);
    const destination = mocks.replace.mock.calls[0]?.[0] as {
      pathname: string;
      params: { imageImportId: string; url: string };
    };
    expect(destination.pathname).toBe("/recipe");
    expect(getPendingImageImport(destination.params.imageImportId)?.images).toEqual(
      await mocks.prepare.mock.results[0]?.value
    );
    await act(() => {
      renderer.unmount();
    });
  });

  it("shows link entry immediately after a photo failure, without navigation to another form", async () => {
    let renderer!: ReturnType<typeof create>;
    await act(() => {
      renderer = create(<ImportRecovery source="image" />);
    });
    expect(mocks.replace).not.toHaveBeenCalled();
    const props = renderer.root.findByType(UrlForm).props as { onSubmit: (url: string) => void };
    await act(() => {
      props.onSubmit("https://example.com/recipe");
    });
    expect(mocks.replace).toHaveBeenCalledWith({
      pathname: "/recipe",
      params: { url: "https://example.com/recipe" }
    });
    await act(() => {
      renderer.unmount();
    });
  });

  it("does nothing when the picker is canceled", async () => {
    mocks.library.mockResolvedValue({ canceled: true });
    let renderer!: ReturnType<typeof create>;
    await act(() => {
      renderer = create(<ImportRecovery source="url" />);
    });
    await act(async () => {
      press(renderer, "Upload recipe photo");
      await Promise.resolve();
    });
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.replace).not.toHaveBeenCalled();
    await act(() => {
      renderer.unmount();
    });
  });

  it("keeps recovery inline if photo preparation fails", async () => {
    mocks.prepare.mockRejectedValue(new Error("Too large"));
    let renderer!: ReturnType<typeof create>;
    await act(() => {
      renderer = create(<ImportRecovery source="url" />);
    });
    await act(async () => {
      press(renderer, "Upload recipe photo");
      await Promise.resolve();
    });
    expect(JSON.stringify(renderer.toJSON())).toContain("paste a recipe link below");
    expect(renderer.root.findByType(UrlForm)).toBeTruthy();
    expect(mocks.replace).not.toHaveBeenCalled();
    await act(() => {
      renderer.unmount();
    });
  });

  it("handles denied camera access without attempting capture", async () => {
    mocks.permission.mockResolvedValue({ granted: false });
    let renderer!: ReturnType<typeof create>;
    await act(() => {
      renderer = create(<ImportRecovery source="url" />);
    });
    await act(async () => {
      press(renderer, "Take a photo");
      await Promise.resolve();
    });
    expect(mocks.camera).not.toHaveBeenCalled();
    expect(JSON.stringify(renderer.toJSON())).toContain("Camera access is off");
    await act(() => {
      renderer.unmount();
    });
  });

  it("offers alternatives for source errors, not consent, billing, or connection failures", () => {
    for (const reason of ["source_blocked", "parse_failed", "unsupported_source", "low_confidence"])
      expect(shouldOfferImportAlternative(reason)).toBe(true);
    for (const reason of [
      "ai_consent_declined",
      "plan_limit",
      "quota_exceeded",
      "transport_error",
      "timeout",
      "unknown"
    ])
      expect(shouldOfferImportAlternative(reason)).toBe(false);
  });
});
