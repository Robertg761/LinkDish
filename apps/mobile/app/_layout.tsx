import { ClerkProvider } from "@clerk/expo";
import { tokenCache } from "@clerk/expo/token-cache";
import { AppFontProvider } from "@linkdish/ui";
import { useFonts } from "expo-font";
import { SplashScreen, Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect, type ReactNode } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { installMobileErrorTracking, trackMobileAppOpened } from "../src/analytics/client";
import { AccountProvider } from "../src/features/account/AccountContext";
import { ClerkSessionBridge } from "../src/features/account/ClerkSessionBridge";
import { NoClerkSessionProvider } from "../src/features/account/ClerkSessionContext";
import { BillingProvider } from "../src/features/billing/BillingContext";
import { UpgradeMomentProvider } from "../src/features/billing/UpgradeMomentContext";
import { FirstRunOnboardingGate } from "../src/features/onboarding/FirstRunOnboardingGate";
import { SavedRecipesProvider } from "../src/features/saved-recipes/SavedRecipesContext";
import { ShoppingListProvider } from "../src/features/shopping/ShoppingListContext";
import { appColors } from "../src/theme/tokens";

const readPublicEnv = (value: unknown): string => (typeof value === "string" ? value : "");
const clerkPublishableKey = readPublicEnv(process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY);
const clerkTokenCacheProps = tokenCache ? { tokenCache } : {};

void SplashScreen.preventAutoHideAsync().catch(() => undefined);

const OptionalClerkProvider = ({ children }: { children: ReactNode }) =>
  clerkPublishableKey ? (
    <ClerkProvider publishableKey={clerkPublishableKey} {...clerkTokenCacheProps}>
      <ClerkSessionBridge>{children}</ClerkSessionBridge>
    </ClerkProvider>
  ) : (
    <NoClerkSessionProvider>{children}</NoClerkSessionProvider>
  );

export default function RootLayout() {
  const [fontsLoaded, fontLoadError] = useFonts({
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
    "Fraunces-Bold": require("../assets/fonts/Fraunces-Bold.ttf"),
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
    "Fraunces-SemiBold": require("../assets/fonts/Fraunces-SemiBold.ttf"),
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
    "Fraunces-SemiBoldItalic": require("../assets/fonts/Fraunces-SemiBoldItalic.ttf")
  });
  const canRender = fontsLoaded || fontLoadError != null;

  useEffect(() => {
    installMobileErrorTracking();
    trackMobileAppOpened();
  }, []);

  useEffect(() => {
    if (fontLoadError) {
      console.warn("Fraunces fonts failed to load; using system serif fallback.", fontLoadError);
    }
  }, [fontLoadError]);

  useEffect(() => {
    if (canRender) {
      void SplashScreen.hideAsync().catch(() => undefined);
    }
  }, [canRender]);

  if (!canRender) {
    return null;
  }

  return (
    <AppFontProvider useFrauncesSerif={fontsLoaded && fontLoadError == null}>
      <OptionalClerkProvider>
        <AccountProvider>
          <BillingProvider>
            <UpgradeMomentProvider>
              <SavedRecipesProvider>
                <ShoppingListProvider>
                  <SafeAreaProvider>
                    <StatusBar style="dark" />
                    <Stack
                      screenOptions={{
                        contentStyle: {
                          backgroundColor: appColors.background
                        },
                        headerShadowVisible: false,
                        headerStyle: {
                          backgroundColor: appColors.background
                        },
                        headerTintColor: appColors.text,
                        headerTitleStyle: {
                          color: appColors.text,
                          fontSize: 17,
                          fontWeight: "600"
                        }
                      }}
                    >
                      <Stack.Screen
                        name="(tabs)"
                        options={{
                          headerShown: false
                        }}
                      />
                      <Stack.Screen
                        name="recipe"
                        options={{
                          title: "Recipe"
                        }}
                      />
                      <Stack.Screen
                        name="import-progress"
                        options={{
                          title: "Importing recipe"
                        }}
                      />
                      <Stack.Screen
                        name="upgrade"
                        options={{
                          title: "LinkDish Plans"
                        }}
                      />
                      <Stack.Screen
                        name="household"
                        options={{
                          title: "Household"
                        }}
                      />
                    </Stack>
                    <FirstRunOnboardingGate />
                  </SafeAreaProvider>
                </ShoppingListProvider>
              </SavedRecipesProvider>
            </UpgradeMomentProvider>
          </BillingProvider>
        </AccountProvider>
      </OptionalClerkProvider>
    </AppFontProvider>
  );
}
