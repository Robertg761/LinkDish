import { AppButton } from "@linkdish/ui";
import { Alert, Linking, Platform, View } from "react-native";

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
    <AppButton
      label="Privacy policy"
      onPress={() => openLink("https://linkdish.ca/privacy/")}
      variant="ghost"
    />
    {Platform.OS === "ios" ? (
      <AppButton
        label="Terms of Use (Apple Standard EULA)"
        onPress={() =>
          openLink("https://www.apple.com/legal/internet-services/itunes/dev/stdeula/")
        }
        variant="ghost"
      />
    ) : null}
    <AppButton
      label="Help and support"
      onPress={() => openLink("https://linkdish.ca/support/")}
      variant="ghost"
    />
  </View>
);
