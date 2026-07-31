import { AppChip } from "@linkdish/ui";
import React from "react";
import { StyleSheet, View } from "react-native";

import { useAccount } from "../account/AccountContext";
import { useBilling } from "../billing/BillingContext";

export const SettingsPlanHeaderBadge = () => {
  const { hasLoadedAccount, user } = useAccount();
  const { plan } = useBilling();

  if (!hasLoadedAccount || !user) {
    return null;
  }

  return (
    <View style={styles.container}>
      <AppChip label={plan.displayName} tone={plan.id === "free" ? "default" : "accent"} />
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    alignItems: "center",
    justifyContent: "center"
  }
});
