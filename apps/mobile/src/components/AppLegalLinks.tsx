import { AppButton } from "@linkdish/ui";
import { Alert, Linking, Platform, View } from "react-native";

import { reviewAiConsent } from "../features/privacy/ai-consent";

const OPEN_SOURCE_LICENCES_URL =
  "https://github.com/Robertg761/LinkDish/blob/main/THIRD_PARTY_NOTICES.md";

const openLink = (url: string) => {
  void Linking.openURL(url).catch(() => {
    Alert.alert(
      "Unable to open link",
      "Please try again, or open this address in your browser: " + url
    );
  });
};

export const AppLegalLinks = () => (
  <View>
    <AppButton label="AI data sharing" onPress={() => void reviewAiConsent()} variant="ghost" />
    {Platform.OS === "ios" ? (
      <AppButton
        label="Manage subscription"
        onPress={() => openLink("https://apps.apple.com/account/subscriptions")}
        variant="ghost"
      />
    ) : null}
    <AppButton
      label="Privacy policy"
      onPress={() => openLink("https://linkdish.ca/privacy/")}
      variant="ghost"
    />
    {/* The LinkDish Terms do not cover iOS yet, so iOS keeps Apple's Standard EULA for now. */}
    {Platform.OS === "ios" ? (
      <AppButton
        label="Terms of Use (Apple Standard EULA)"
        onPress={() =>
          openLink("https://www.apple.com/legal/internet-services/itunes/dev/stdeula/")
        }
        variant="ghost"
      />
    ) : (
      <AppButton
        label="Terms of Service"
        onPress={() => openLink("https://linkdish.ca/terms/")}
        variant="ghost"
      />
    )}
    <AppButton
      label="Help and support"
      onPress={() => openLink("https://linkdish.ca/support/")}
      variant="ghost"
    />
    <AppButton
      label="Open source licences"
      onPress={() => openLink(OPEN_SOURCE_LICENCES_URL)}
      variant="ghost"
    />
  </View>
);
