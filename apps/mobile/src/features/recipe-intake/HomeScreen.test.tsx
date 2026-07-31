import React from "react";
import { act, create } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
  Modal: (props: { visible?: boolean; children?: React.ReactNode }) => {
    console.log("Modal props.visible:", props.visible);
    console.log("Modal has children:", !!props.children);
    return props.visible ? React.createElement("modal", null, props.children) : null;
  },
  Platform: {
    OS: "ios"
  },
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

  it("keeps anonymous users locally gated when free imports are exhausted", async () => {
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

    expect(routerMocks.push).toHaveBeenCalledWith("/upgrade");
  });

  it("routes a camera scan to the recipe screen with a pending image import", async () => {
    billingState.canStartImport.mockReturnValue({
      allowed: true
    });
    billingState.remainingImports = 3;

    let renderer: ReturnType<typeof create>;

    await act(async () => {
      renderer = create(<HomeScreen />);
      await flushAsyncWork();
    });

    const urlFormProps = urlFormState.props as unknown as { onCameraPress?: () => void };
    act(() => {
      urlFormProps.onCameraPress?.();
    });

    const appTexts = renderer!.root.findAll((node) => (node.type as unknown) === "AppText");
    const takePhotoTextNode = appTexts.find((node) => {
      const text = String(
        Array.isArray(node.props.children) ? node.props.children.join("") : node.props.children
      );
      return text.trim().toLowerCase() === "take photo";
    });
    let takePhotoParent = takePhotoTextNode?.parent;
    while (takePhotoParent && (takePhotoParent.type as unknown) !== "pressable") {
      takePhotoParent = takePhotoParent.parent;
    }
    const takePhotoButton = takePhotoParent;

    if (!takePhotoButton) {
      console.log("TAKE PHOTO BUTTON NOT FOUND. TREE:", JSON.stringify(renderer!.toJSON()));
    } else {
      console.log("takePhotoButton props:", Object.keys(takePhotoButton.props));
    }

    await act(async () => {
      const onPress = (takePhotoButton?.props as { onPress?: () => void })?.onPress;
      if (onPress) onPress();
      await flushAsyncWork();
    });

    expect(imagePickerMocks.requestCameraPermissionsAsync).toHaveBeenCalled();
    expect(imagePickerMocks.launchCameraAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        base64: true,
        mediaTypes: ["images"]
      })
    );
    const pushedRoute = routerMocks.push.mock.calls.at(-1)?.[0] as
      | {
          params?: {
            imageImportId?: unknown;
            url?: unknown;
          };
          pathname?: unknown;
        }
      | undefined;
    expect(pushedRoute?.pathname).toBe("/recipe");
    expect(typeof pushedRoute?.params?.imageImportId).toBe("string");
    expect(pushedRoute?.params?.url).toEqual(
      expect.stringMatching(/^https:\/\/linkdish\.app\/image-imports\/image-/u)
    );
  });

  it("rejects image selections that exceed the aggregate payload limit", async () => {
    billingState.canStartImport.mockReturnValue({
      allowed: true
    });
    imagePickerMocks.launchImageLibraryAsync.mockResolvedValueOnce({
      canceled: false,
      assets: [
        {
          base64: "a".repeat(4_100_000),
          mimeType: "image/jpeg"
        },
        {
          base64: "a".repeat(4_100_000),
          mimeType: "image/jpeg"
        }
      ]
    });

    let renderer: ReturnType<typeof create>;

    await act(async () => {
      renderer = create(<HomeScreen />);
      await flushAsyncWork();
    });

    const urlFormProps = urlFormState.props as unknown as { onCameraPress?: () => void };
    act(() => {
      urlFormProps.onCameraPress?.();
    });

    const appTexts = renderer!.root.findAll((node) => (node.type as unknown) === "AppText");
    const choosePhotosTextNode = appTexts.find((node) => {
      const text = String(
        Array.isArray(node.props.children) ? node.props.children.join("") : node.props.children
      );
      return text.trim().toLowerCase() === "choose from gallery";
    });
    let choosePhotosParent = choosePhotosTextNode?.parent;
    while (choosePhotosParent && (choosePhotosParent.type as unknown) !== "pressable") {
      choosePhotosParent = choosePhotosParent.parent;
    }
    const choosePhotosButton = choosePhotosParent;

    if (!choosePhotosButton) {
      console.log("CHOOSE PHOTOS BUTTON NOT FOUND. TREE:", JSON.stringify(renderer!.toJSON()));
    }

    await act(async () => {
      const onPress = (choosePhotosButton?.props as { onPress?: () => void })?.onPress;
      if (onPress) onPress();
      await flushAsyncWork();
    });

    expect(routerMocks.push).not.toHaveBeenCalled();
    expect(JSON.stringify(renderer!.toJSON())).toContain(
      "That image was too large or could not be read. Try a clearer photo."
    );
  });
});
