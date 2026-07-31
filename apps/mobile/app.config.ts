import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  withAndroidManifest,
  withAppBuildGradle,
  withDangerousMod,
  type ConfigPlugin
} from "expo/config-plugins";

import type { ExpoConfig } from "expo/config";

const getEnvValue = (key: string): string | undefined => {
  const value = (process.env as Record<string, string | undefined>)[key];
  return typeof value === "string" ? value : undefined;
};

const DEBUG_APP_NAME_XML = `<resources>
  <string name="app_name">LinkDish Debug</string>
</resources>
`;

const BRAND_DIALOG_STYLE = `  <style name="AppAlertDialogTheme" parent="ThemeOverlay.AppCompat.Dialog.Alert">
    <item name="colorAccent">#29443b</item>
  </style>
`;

const ensureAndroidDialogTheme = (contents: string): string => {
  let nextContents = contents;

  const appThemeMarker = '<style name="AppTheme" parent="Theme.AppCompat.DayNight.NoActionBar">';
  const appThemeItems = [
    '    <item name="android:alertDialogTheme">@style/AppAlertDialogTheme</item>',
    '    <item name="alertDialogTheme">@style/AppAlertDialogTheme</item>',
    '    <item name="colorAccent">#29443b</item>'
  ];

  for (const item of appThemeItems) {
    if (!nextContents.includes(item)) {
      nextContents = nextContents.replace(appThemeMarker, `${appThemeMarker}\n${item}`);
    }
  }

  if (!nextContents.includes('name="AppAlertDialogTheme"')) {
    nextContents = nextContents.replace(
      '  <style name="Theme.App.SplashScreen"',
      `${BRAND_DIALOG_STYLE}  <style name="Theme.App.SplashScreen"`
    );
  }

  return nextContents;
};

const withAndroidDebugIdentity: ConfigPlugin = (config) => {
  const configWithDebugSuffix = withAppBuildGradle(config, (modConfig) => {
    if (modConfig.modResults.language !== "groovy") {
      return modConfig;
    }

    const buildTypesDebugBlock =
      /(buildTypes\s*\{\s*\n\s*debug\s*\{)([\s\S]*?)(\n\s*\}\s*release\s*\{)/;
    const contents = modConfig.modResults.contents;
    const match = contents.match(buildTypesDebugBlock);

    if (match && !match[2]?.includes("applicationIdSuffix")) {
      modConfig.modResults.contents = contents.replace(
        buildTypesDebugBlock,
        "$1\n            applicationIdSuffix '.debug'$2$3"
      );
    }

    return modConfig;
  });

  return withDangerousMod(configWithDebugSuffix, [
    "android",
    (modConfig) => {
      const valuesDir = path.join(
        modConfig.modRequest.platformProjectRoot,
        "app/src/debug/res/values"
      );

      mkdirSync(valuesDir, { recursive: true });
      writeFileSync(path.join(valuesDir, "strings.xml"), DEBUG_APP_NAME_XML);

      return modConfig;
    }
  ]);
};

const withAndroidDialogTheme: ConfigPlugin = (config) =>
  withDangerousMod(config, [
    "android",
    (modConfig) => {
      const stylesPath = path.join(
        modConfig.modRequest.platformProjectRoot,
        "app/src/main/res/values/styles.xml"
      );
      const contents = readFileSync(stylesPath, "utf8");
      writeFileSync(stylesPath, ensureAndroidDialogTheme(contents));

      return modConfig;
    }
  ]);

const withAndroidUnrestrictedOrientation: ConfigPlugin = (config) =>
  withAndroidManifest(config, (modConfig) => {
    const applications = modConfig.modResults.manifest.application ?? [];

    for (const application of applications) {
      for (const activity of application.activity ?? []) {
        if (activity.$?.["android:name"]?.endsWith("MainActivity")) {
          delete activity.$["android:screenOrientation"];
        }
      }
    }

    return modConfig;
  });

const appVersion = getEnvValue("LINKDISH_APP_VERSION") ?? "2.0.6";
const iosBuildNumber = getEnvValue("LINKDISH_IOS_BUILD_NUMBER") ?? "29";
const androidVersionCode = Number.parseInt(
  getEnvValue("LINKDISH_ANDROID_VERSION_CODE") ?? "30",
  10
);
const applicationId = getEnvValue("LINKDISH_APPLICATION_ID") ?? "com.linkdish.app";
const androidConfig = {
  package: applicationId,
  versionCode: androidVersionCode,
  allowBackup: false,
  usesCleartextTraffic: false,
  permissions: [
    "android.permission.CAMERA",
    "android.permission.INTERNET",
    "com.android.vending.BILLING"
  ],
  blockedPermissions: [
    "android.permission.RECORD_AUDIO",
    "android.permission.SYSTEM_ALERT_WINDOW",
    "android.permission.READ_EXTERNAL_STORAGE",
    "android.permission.WRITE_EXTERNAL_STORAGE"
  ],
  adaptiveIcon: {
    backgroundColor: "#fff7ed",
    foregroundImage: "./assets/adaptive-icon.png"
  },
  intentFilters: [
    {
      action: "SEND",
      category: ["DEFAULT"],
      data: [
        {
          mimeType: "text/plain"
        }
      ]
    },
    {
      action: "SEND",
      category: ["DEFAULT"],
      data: [
        {
          mimeType: "image/*"
        }
      ]
    }
  ]
} as NonNullable<ExpoConfig["android"]>;

const config: ExpoConfig = {
  name: "LinkDish",
  slug: "linkdish",
  scheme: "linkdish",
  version: appVersion,
  runtimeVersion: {
    policy: "appVersion"
  },
  orientation: "portrait",
  userInterfaceStyle: "light",
  icon: "./assets/icon.png",
  plugins: [
    "expo-router",
    "expo-secure-store",
    "expo-sharing",
    "expo-status-bar",
    [
      "expo-splash-screen",
      {
        backgroundColor: "#f4efe7",
        image: "./assets/splash-wordmark.png",
        resizeMode: "contain"
      }
    ],
    "expo-web-browser",
    [
      "expo-image-picker",
      {
        cameraPermission: "LinkDish uses your camera to scan recipes from paper or cookbooks.",
        microphonePermission: "LinkDish does not use the microphone.",
        photosPermission: "LinkDish uses selected photos to scan saved recipe images."
      }
    ],
    [
      "./plugins/withAndroidShareIntentDeepLinks",
      {
        scheme: "linkdish"
      }
    ],
    "@clerk/expo"
  ],
  experiments: {
    typedRoutes: true
  },
  android: androidConfig,
  ios: {
    bundleIdentifier: applicationId,
    buildNumber: iosBuildNumber,
    supportsTablet: false,
    config: {
      usesNonExemptEncryption: false
    }
  },
  web: {
    bundler: "metro"
  },
  extra: {
    eas: {
      projectId: getEnvValue("EAS_PROJECT_ID") ?? "a2c1318c-39e0-45a3-a114-1f5e88288af1"
    },
    EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: getEnvValue("EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY"),
    EXPO_PUBLIC_CLERK_GOOGLE_ANDROID_CLIENT_ID: getEnvValue(
      "EXPO_PUBLIC_CLERK_GOOGLE_ANDROID_CLIENT_ID"
    ),
    EXPO_PUBLIC_CLERK_GOOGLE_IOS_CLIENT_ID: getEnvValue("EXPO_PUBLIC_CLERK_GOOGLE_IOS_CLIENT_ID"),
    EXPO_PUBLIC_CLERK_GOOGLE_IOS_URL_SCHEME: getEnvValue("EXPO_PUBLIC_CLERK_GOOGLE_IOS_URL_SCHEME"),
    EXPO_PUBLIC_CLERK_GOOGLE_WEB_CLIENT_ID: getEnvValue("EXPO_PUBLIC_CLERK_GOOGLE_WEB_CLIENT_ID")
  }
};

export default withAndroidUnrestrictedOrientation(
  withAndroidDialogTheme(withAndroidDebugIdentity(config))
);
