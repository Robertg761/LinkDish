import { AppButton, AppSurface, AppText } from "@linkdish/ui";
import React, { useState } from "react";
import { StyleSheet } from "react-native";

import { AppDialog } from "../../components/AppDialog";

import { useCookbookSync } from "./CookbookSyncContext";

const formatSyncedAt = (time: number, now = Date.now()): string =>
  now - time < 60_000
    ? "Synced just now."
    : `Last synced at ${new Date(time).toLocaleTimeString(undefined, {
        hour: "numeric",
        minute: "2-digit"
      })}.`;

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** Cloud sync's state on the Household screen; nothing while it is off (or not switched on). */
export const CookbookSyncCard = () => {
  const sync = useCookbookSync();
  const [confirmMessage, setConfirmMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [switchFailed, setSwitchFailed] = useState(false);

  if (sync.phase === "off") {
    return null;
  }

  if (sync.phase === "other_account") {
    const askToSwitch = () => {
      setSwitchFailed(false);
      void sync
        .countChangesNotSynced()
        .catch(() => 0)
        .then((unsynced) => {
          setConfirmMessage(
            "The recipes on this device are removed (starter recipes stay) and your own cookbook " +
              "comes in. The other account keeps its cookbook." +
              (unsynced
                ? ` ${plural(unsynced, "change", "changes")} made here haven't synced to the other account yet and will be lost.`
                : "")
          );
        });
    };

    return (
      <>
        <AppSurface style={styles.card}>
          <AppText style={styles.centered} variant="title">
            This cookbook syncs with another account
          </AppText>
          <AppText muted style={styles.centered}>
            The recipes on this device belong to the account that signed in here first, so they
            don&apos;t sync with yours. Your own cookbook is safe in your account.
          </AppText>
          {switchFailed ? (
            <AppText style={styles.centered}>
              This device&apos;s cookbook couldn&apos;t be replaced. Try again.
            </AppText>
          ) : null}
          <AppButton
            disabled={busy}
            label={busy ? "Switching" : "Use my cookbook here"}
            onPress={askToSwitch}
            variant="outline"
          />
        </AppSurface>
        <AppDialog
          actions={[
            {
              label: "Keep it",
              onPress: () => setConfirmMessage(null),
              variant: "outline"
            },
            {
              label: "Replace",
              onPress: () => {
                setConfirmMessage(null);
                setBusy(true);
                void sync
                  .switchToAccountCookbook()
                  .catch(() => setSwitchFailed(true))
                  .finally(() => setBusy(false));
              },
              variant: "danger"
            }
          ]}
          message={confirmMessage ?? ""}
          onRequestClose={() => setConfirmMessage(null)}
          title="Replace this device's cookbook?"
          visible={confirmMessage !== null}
        />
      </>
    );
  }

  const line =
    sync.phase === "syncing"
      ? "Syncing your cookbook…"
      : sync.phase === "offline"
        ? "You're offline. Changes made here sync when you're back online."
        : sync.phase === "error"
          ? "Your cookbook couldn't sync just now."
          : sync.lastSyncedAt
            ? formatSyncedAt(sync.lastSyncedAt)
            : "";

  return (
    <AppSurface style={styles.card}>
      <AppText style={styles.centered} variant="title">
        Cookbook sync
      </AppText>
      <AppText muted style={styles.centered}>
        Your saved recipes, notes and favorites sync between this device and LinkDish on the web
        wherever you&apos;re signed in.
      </AppText>
      {line ? <AppText style={styles.centered}>{line}</AppText> : null}
      {sync.held ? (
        <AppText muted style={styles.centered}>
          {plural(sync.held, "recipe", "recipes")} couldn&apos;t sync because{" "}
          {sync.held === 1 ? "it's" : "they're"} too large or past a cookbook limit.
        </AppText>
      ) : null}
      {sync.phase === "synced" || sync.phase === "error" ? (
        <AppButton
          disabled={busy}
          label={sync.phase === "error" ? "Try again" : "Sync now"}
          onPress={() => {
            setBusy(true);
            void sync.syncNow().finally(() => setBusy(false));
          }}
          variant="outline"
        />
      ) : null}
    </AppSurface>
  );
};

const styles = StyleSheet.create({
  card: {
    alignItems: "center",
    gap: 14
  },
  centered: {
    textAlign: "center"
  }
});
