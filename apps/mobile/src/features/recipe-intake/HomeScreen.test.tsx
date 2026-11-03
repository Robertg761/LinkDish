import React from "react";
import { act, create } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const modalState = vi.hoisted(() => ({ onDismiss: undefined as (() => void) | undefined }));
const platformState = vi.hoisted(() => ({ OS: "ios" }));
const prepareImagesMock = vi.hoisted(() => vi.fn());

const accountState = vi.hoisted(() => ({
  isSignedIn: false,
  sessionToken: null as string | null
}));

const asyncStorageMocks = vi.hoisted(() => ({
  getItem: vi.fn(),
  setItem: vi.fn()
}));

const billingState = vi.hoisted(() => ({
  canStartImport: vi.fn(),
  hasLoadedBilling: true,
  plan: {
    displayName: "Free"
  },
  remainingImports: 0,
  tier: "free"
}));

const routerMocks = vi.hoisted(() => ({
  push: vi.fn()
}));

const imagePickerMocks = vi.hoisted(() => ({
  launchCameraAsync: vi.fn(),
  launchImageLibraryAsync: vi.fn(),
  requestCameraPermissionsAsync: vi.fn(),
  requestMediaLibraryPermissionsAsync: vi.fn()
}));

const urlFormState = vi.hoisted(() => ({
  props: null as {
    disabled?: boolean;
    helperText?: string;
    onSubmit: (url: string) => void;
  } | null
}));

vi.mock("react-native", () => ({
  AccessibilityInfo: {
    isReduceMotionEnabled: () => Promise.resolve(false),
    addEventListener: () => ({ remove: () => undefined })
  },
  ActivityIndicator: ({ color }: { color?: string }) =>
    React.createElement("activity-indicator", { color }),
  Animated: {
    View: ({ children, ...props }: { children: React.ReactNode }) =>
      React.createElement("animated-view", props, children),
    Value: class {
      private value: number;

      constructor(value: number) {
        this.value = value;
      }

      interpolate() {
        return this.value;
      }

      setValue(value: number) {
        this.value = value;
      }
    },
    timing: (value: { setValue: (nextValue: number) => void }, config: { toValue: number }) => ({
      start: (callback?: (result: { finished: boolean }) => void) => {
        value.setValue(config.toValue);
        if (callback) {
          void Promise.resolve().then(() => callback({ finished: true }));
        }
      }
    })
  },
  Easing: {
    bezier: vi.fn(() => (val: number) => val),
    cubic: vi.fn((value: number) => value),
    out: vi.fn((easing: unknown) => easing)
  },
  KeyboardAvoidingView: ({ children }: { children: React.ReactNode }) =>
    React.createElement("keyboard-avoiding-view", null, children),
  Modal: (props: { visible?: boolean; children?: React.ReactNode; onDismiss?: () => void }) => {
    modalState.onDismiss = props.onDismiss;
    return props.visible ? React.createElement("modal", null, props.children) : null;
  },
  Platform: platformState,
  Pressable: ({ children, ...props }: { children: React.ReactNode }) =>
    React.createElement("pressable", props, children),
  ScrollView: ({ children }: { children: React.ReactNode }) =>
    React.createElement("scroll-view", null, children),
  StyleSheet: {
    create: <T,>(styles: T) => styles
  },
  useWindowDimensions: vi.fn(() => ({ width: 375, height: 812 })),
  View: ({ children, ...props }: { children?: React.ReactNode }) =>
    React.createElement("view", props, children)
}));

vi.mock("@expo/vector-icons", () => ({
  MaterialCommunityIcons: ({ name }: { name: string }) =>
    React.createElement("MaterialCommunityIcons", { name })
}));

vi.mock("@linkdish/ui", () => ({
  AppButton: ({
    disabled,
    label,
    onPress,
    variant
  }: {
    disabled?: boolean;
    label: string;
    onPress: () => void;
    variant?: string;
  }) => React.createElement("AppButton", { disabled, onPress, variant }, label),
  AppSurface: ({ children }: { children: React.ReactNode }) =>
    React.createElement("AppSurface", null, children),
  AppText: ({
    children,
    italic,
    tone
  }: {
    children: React.ReactNode;
    italic?: boolean;
    tone?: string;
  }) => React.createElement("AppText", { italic, tone }, children)
}));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: asyncStorageMocks
}));

vi.mock("expo-router", () => ({
  router: routerMocks
}));

vi.mock("expo-image-picker", () => imagePickerMocks);
vi.mock("./preparePickedImages", () => ({ preparePickedImages: prepareImagesMock }));

vi.mock("../account/AccountContext", () => ({
  useAccount: () => accountState
}));

vi.mock("../billing/BillingContext", () => ({
  useBilling: () => billingState
}));

vi.mock("./components/UrlForm", () => ({
  UrlForm: (props: {
    disabled?: boolean;
    helperText?: string;
    onSubmit: (url: string) => void;
  }) => {
    urlFormState.props = props;
    return React.createElement("UrlForm");
  }
}));

const pasteTextSheetState = vi.hoisted(() => ({
  props: null as {
    onImportText: (text: string) => void;
    visible: boolean;
  } | null
}));

vi.mock("./components/PasteTextSheet", () => ({
  PasteTextSheet: (props: { onImportText: (text: string) => void; visible: boolean }) => {
    pasteTextSheetState.props = props;
    return null;
  }
}));

vi.mock("./intakeResetEvents", () => ({
  subscribeToRecipeUrlReset: vi.fn(() => () => undefined)
}));

vi.mock("../../hooks/useSmoothKeyboardInset", () => ({
  useSmoothKeyboardInset: () => 0
}));

vi.mock("../../theme/tokens", () => ({
  appColors: {
    accent: "#6f5cff",
    accentSoft: "#ece9ff",
    background: "#fffaf4",
    surface: "#ffffff"
  },
  appSpacing: {
    xs: 4,
    sm: 8,
    md: 12,
    lg: 16,
    xl: 20,
    xxl: 24,
    xxxl: 32
  }
}));

import HomeScreen from "../../../app/(tabs)/import";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const flushAsyncWork = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

describe("HomeScreen import gate", () => {
  beforeEach(() => {
    platformState.OS = "ios";
    modalState.onDismiss = undefined;
    prepareImagesMock.mockReset();
    prepareImagesMock.mockResolvedValue([
      { dataUrl: "data:image/jpeg;base64,abc123", mimeType: "image/jpeg" }
    ]);
    accountState.isSignedIn = false;
    accountState.sessionToken = null;
    billingState.canStartImport.mockReset();
    billingState.canStartImport.mockReturnValue({
      allowed: false,
      message: "You have used your free recipe imports."
    });
    billingState.hasLoadedBilling = true;
    billingState.plan = {
      displayName: "Free"
    };
    billingState.remainingImports = 0;
    billingState.tier = "free";
    asyncStorageMocks.getItem.mockReset();
    asyncStorageMocks.setItem.mockReset();
    asyncStorageMocks.getItem.mockResolvedValue("true");
    asyncStorageMocks.setItem.mockResolvedValue(undefined);
    routerMocks.push.mockReset();
    imagePickerMocks.launchCameraAsync.mockReset();
    imagePickerMocks.launchImageLibraryAsync.mockReset();
    imagePickerMocks.requestCameraPermissionsAsync.mockReset();
    imagePickerMocks.requestMediaLibraryPermissionsAsync.mockReset();
    imagePickerMocks.requestCameraPermissionsAsync.mockResolvedValue({ granted: true });
    imagePickerMocks.requestMediaLibraryPermissionsAsync.mockResolvedValue({ granted: true });
    imagePickerMocks.launchCameraAsync.mockResolvedValue({
      canceled: false,
      assets: [
        {
          base64: "abc123",
          mimeType: "image/jpeg"
        }
      ]
    });
    imagePickerMocks.launchImageLibraryAsync.mockResolvedValue({
      canceled: false,
      assets: [
        {
          base64: "abc123",
          mimeType: "image/jpeg"
        }
      ]
    });
    urlFormState.props = null;
  });

  it("lets signed-in users submit without waiting on local billing so server household billing can apply", async () => {
    accountState.isSignedIn = true;
    accountState.sessionToken = "session-token";
    billingState.hasLoadedBilling = false;

    let renderer: ReturnType<typeof create>;

    await act(async () => {
      renderer = create(<HomeScreen />);
      await flushAsyncWork();
    });

    const screen = JSON.stringify(renderer!.toJSON());
    expect(screen).not.toContain("LinkDish account");
    expect(screen).not.toContain("Recipe imports are checked securely when you submit.");
    expect(screen).not.toContain("Free");
    expect(screen).not.toContain("0 recipe imports left this month");
    expect(screen).not.toContain("View Plans");
    expect(billingState.canStartImport).not.toHaveBeenCalled();
    expect(urlFormState.props?.disabled).toBe(false);
    expect(urlFormState.props?.helperText).toBeUndefined();

    act(() => {
      urlFormState.props?.onSubmit("https://example.com/household");
    });

    expect(routerMocks.push).toHaveBeenCalledWith({
      pathname: "/recipe",
      params: {
        url: "https://example.com/household"
      }
    });
  });

  it("opens the recipe limit screen when anonymous free imports are exhausted", async () => {
    await act(async () => {
      create(<HomeScreen />);
      await flushAsyncWork();
    });

    expect(billingState.canStartImport).toHaveBeenCalled();
    expect(urlFormState.props?.disabled).toBe(false);
    expect(urlFormState.props?.helperText).toBe("You have used your free recipe imports.");

    act(() => {
      urlFormState.props?.onSubmit("https://example.com/free-limit");
    });

    expect(routerMocks.push).toHaveBeenCalledWith({
      pathname: "/recipe",
      params: { url: "https://example.com/free-limit" }
    });
  });

  const openScanSheet = async () => {
    billingState.canStartImport.mockReturnValue({ allowed: true });
    let renderer: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(<HomeScreen />);
      await flushAsyncWork();
    });
    act(() => {
      (urlFormState.props as unknown as { onCameraPress: () => void }).onCameraPress();
    });
    return renderer!;
  };

  const findOption = (renderer: ReturnType<typeof create>, label: string) => {
    const text = renderer.root
      .findAll((node) => (node.type as unknown) === "AppText")
      .find((node) => node.props.children === label);
    let button = text?.parent;
    while (button && (button.type as unknown) !== "pressable") button = button.parent;
    if (!button) throw new Error(`Missing scan option: ${label}`);
    return button.props.onPress as () => void;
  };

  const dismissSheet = async () => {
    await act(async () => {
      modalState.onDismiss?.();
      await flushAsyncWork();
    });
  };

  it.each([
    ["Take Photo", "camera"],
    ["Choose from Gallery", "library"]
  ] as const)(
    "waits for native dismissal before opening %s, then routes the prepared images",
    async (label, source) => {
      const renderer = await openScanSheet();
      const press = findOption(renderer, label);
      await act(async () => {
        press();
        press();
        await flushAsyncWork();
      });
      expect(imagePickerMocks.launchCameraAsync).not.toHaveBeenCalled();
      expect(imagePickerMocks.launchImageLibraryAsync).not.toHaveBeenCalled();
      expect(imagePickerMocks.requestCameraPermissionsAsync).not.toHaveBeenCalled();
      expect(routerMocks.push).not.toHaveBeenCalled();

      await dismissSheet();
      await dismissSheet(); // Duplicate native callbacks must not open another picker.
      const launch =
        source === "camera"
          ? imagePickerMocks.launchCameraAsync
          : imagePickerMocks.launchImageLibraryAsync;
      expect(launch).toHaveBeenCalledTimes(1);
      expect(launch).toHaveBeenCalledWith(
        expect.objectContaining({ base64: false, mediaTypes: ["images"] })
      );
      expect(prepareImagesMock).toHaveBeenCalledTimes(1);
      expect(routerMocks.push).toHaveBeenCalledTimes(1);
      expect(routerMocks.push).toHaveBeenCalledWith({
        pathname: "/recipe",
        params: {
          imageImportId: expect.any(String) as unknown,
          url: expect.stringMatching(/^https:\/\/linkdish\.app\/image-imports\/image-/u) as unknown
        }
      });
      act(() => renderer.unmount());
    }
  );

  it("shows preparation errors without routing a partial selection", async () => {
    prepareImagesMock.mockRejectedValueOnce(new Error("Too large"));
    const renderer = await openScanSheet();
    await act(async () => {
      findOption(renderer, "Choose from Gallery")();
      await flushAsyncWork();
    });
    await dismissSheet();
    expect(routerMocks.push).not.toHaveBeenCalled();
    expect(JSON.stringify(renderer.toJSON())).toContain(
      "Those photos could not be prepared for import."
    );
    expect(urlFormState.props?.disabled).toBe(false);
    act(() => renderer.unmount());
  });

  it("does not launch the camera when permission is denied", async () => {
    imagePickerMocks.requestCameraPermissionsAsync.mockResolvedValueOnce({ granted: false });
    const renderer = await openScanSheet();
    await act(async () => {
      findOption(renderer, "Take Photo")();
      await flushAsyncWork();
    });
    await dismissSheet();
    expect(imagePickerMocks.launchCameraAsync).not.toHaveBeenCalled();
    expect(routerMocks.push).not.toHaveBeenCalled();
    expect(JSON.stringify(renderer.toJSON())).toContain("Camera access is needed");
    act(() => renderer.unmount());
  });

  it("allows retry after cancelling the library picker", async () => {
    imagePickerMocks.launchImageLibraryAsync.mockResolvedValueOnce({
      canceled: true,
      assets: null
    });
    const renderer = await openScanSheet();
    await act(async () => {
      findOption(renderer, "Choose from Gallery")();
      await flushAsyncWork();
    });
    await dismissSheet();
    expect(prepareImagesMock).not.toHaveBeenCalled();
    expect(routerMocks.push).not.toHaveBeenCalled();
    act(() => {
      (urlFormState.props as unknown as { onCameraPress: () => void }).onCameraPress();
    });
    await act(async () => {
      findOption(renderer, "Choose from Gallery")();
      await flushAsyncWork();
    });
    await dismissSheet();
    expect(imagePickerMocks.launchImageLibraryAsync).toHaveBeenCalledTimes(2);
    expect(routerMocks.push).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });

  it("launches on Android after closing the sheet without requiring an iOS dismissal event", async () => {
    platformState.OS = "android";
    const renderer = await openScanSheet();
    await act(async () => {
      findOption(renderer, "Choose from Gallery")();
      await flushAsyncWork();
    });
    expect(imagePickerMocks.launchImageLibraryAsync).toHaveBeenCalledTimes(1);
    expect(routerMocks.push).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });

  it("does not open a picker when the scan sheet is cancelled", async () => {
    const renderer = await openScanSheet();
    await act(async () => {
      findOption(renderer, "Cancel")();
      await flushAsyncWork();
    });
    await dismissSheet();
    expect(imagePickerMocks.launchImageLibraryAsync).not.toHaveBeenCalled();
    expect(imagePickerMocks.launchCameraAsync).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it("opens the paste-text sheet and imports pasted text on the recipe screen", async () => {
    accountState.isSignedIn = true;
    let renderer: ReturnType<typeof create>;

    await act(async () => {
      renderer = create(<HomeScreen />);
      await flushAsyncWork();
    });

    expect(pasteTextSheetState.props?.visible).toBe(false);

    await act(async () => {
      (
        renderer!.root.findByProps({ testID: "paste-text-button" }).props as { onPress: () => void }
      ).onPress();
      await flushAsyncWork();
    });

    expect(pasteTextSheetState.props?.visible).toBe(true);

    await act(async () => {
      pasteTextSheetState.props?.onImportText("Pancakes: 2 eggs, 1 cup flour, fry them.");
      await flushAsyncWork();
    });

    expect(routerMocks.push).toHaveBeenCalledWith({
      pathname: "/recipe",
      params: {
        textImportId: expect.stringMatching(/^text-/u) as unknown,
        url: expect.stringMatching(
          /^https:\/\/linkdish\.app\/text-imports\/android-text-/u
        ) as unknown
      }
    });
    expect(pasteTextSheetState.props?.visible).toBe(false);
  });

  it("sends free users who are out of imports to the plans before they paste", async () => {
    let renderer: ReturnType<typeof create>;

    await act(async () => {
      renderer = create(<HomeScreen />);
      await flushAsyncWork();
    });

    await act(async () => {
      (
        renderer!.root.findByProps({ testID: "paste-text-button" }).props as { onPress: () => void }
      ).onPress();
      await flushAsyncWork();
    });

    expect(routerMocks.push).toHaveBeenCalledWith("/upgrade");
    expect(pasteTextSheetState.props?.visible).toBe(false);
  });
});
