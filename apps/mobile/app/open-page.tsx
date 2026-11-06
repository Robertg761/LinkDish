import { DomWebView, type DomWebViewRef } from "@expo/dom-webview";
import { AppButton, AppText } from "@linkdish/ui";
import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { createPendingPageImport } from "../src/features/recipe-intake/pageImport";
import {
  PAGE_SHOWN_SCRIPT,
  buildCaptureScript,
  isSameSitePublicPage,
  pageProblemMessage,
  pageSiteLabel,
  prepareCapturedPage,
  readPageViewMessage,
  resolvePageSite,
  unwrapFacebookLinkWrapper
} from "../src/services/device-page";
import { appColors, appSpacing } from "../src/theme/tokens";

/* The page answers a Save tap at once; past this, something in it is stuck. */
const CAPTURE_TIMEOUT_MS = 10_000;

const readFirstParam = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

/**
 * A recipe site that blocks LinkDish's servers, opened in an in-app browser view. The person
 * sees the page load as in any browser and taps Save recipe; the app then reads the page they
 * are looking at and sends it to be imported. Nothing is read before that tap.
 */
export default function OpenPageScreen() {
  const params = useLocalSearchParams<{ url?: string | string[] }>();
  const requestedUrl = readFirstParam(params.url);
  const pageUrl = useMemo(
    () => (requestedUrl ? unwrapFacebookLinkWrapper(requestedUrl) : undefined),
    [requestedUrl]
  );
  const canOpen = pageUrl !== undefined && isSameSitePublicPage(pageUrl, pageUrl);
  const webViewRef = useRef<DomWebViewRef>(null);
  const captureNonceRef = useRef<string | null>(null);
  const captureTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /* The site a saved page must be on (a shortened link's destination once it shows). */
  const pageSiteRef = useRef<string | null>(null);
  const [shownHref, setShownHref] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const stopWaiting = useCallback(() => {
    captureNonceRef.current = null;

    if (captureTimerRef.current) {
      clearTimeout(captureTimerRef.current);
      captureTimerRef.current = null;
    }

    setIsSaving(false);
  }, []);

  useEffect(
    () => () => {
      if (captureTimerRef.current) {
        clearTimeout(captureTimerRef.current);
      }
    },
    []
  );

  const saveRecipe = useCallback(() => {
    const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;

    captureNonceRef.current = nonce;
    setProblem(null);
    setIsSaving(true);
    captureTimerRef.current = setTimeout(() => {
      stopWaiting();
      setProblem("LinkDish couldn't read this page. Let it finish loading, then try again.");
    }, CAPTURE_TIMEOUT_MS);
    webViewRef.current?.injectJavaScript(buildCaptureScript(nonce));
  }, [stopWaiting]);

  const handleMessage = useCallback(
    (event: { nativeEvent: { data: string } }) => {
      const message = readPageViewMessage(event.nativeEvent.data);

      if (!message || !pageUrl) {
        return;
      }

      if (message.kind === "shown") {
        pageSiteRef.current = resolvePageSite(pageUrl, pageSiteRef.current, message.href);
        setShownHref(message.href);
        return;
      }

      if (!captureNonceRef.current || message.nonce !== captureNonceRef.current) {
        return;
      }

      stopWaiting();
      const pageSite = resolvePageSite(pageUrl, pageSiteRef.current, null) ?? pageUrl;
      const prepared = prepareCapturedPage(pageSite, { href: message.href, html: message.html });

      if ("problem" in prepared) {
        setProblem(pageProblemMessage(prepared.problem, pageSite));
        return;
      }

      const pendingImport = createPendingPageImport(message.href, prepared.page);
      router.replace({
        pathname: "/recipe",
        params: { pageImportId: pendingImport.id, url: pendingImport.url }
      });
    },
    [pageUrl, stopWaiting]
  );

  if (!canOpen || !pageUrl) {
    return (
      <SafeAreaView edges={["bottom"]} style={styles.screen}>
        <View style={styles.notice}>
          <AppText muted>LinkDish can't open that link here.</AppText>
        </View>
        <View style={styles.actions}>
          <AppButton label="Back" onPress={() => router.back()} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <View style={styles.notice}>
        <AppText muted style={styles.noticeText}>
          {problem ??
            `${pageSiteLabel(pageUrl)} opens here as it would in your browser. When you can see the recipe, tap Save recipe.`}
        </AppText>
      </View>
      <DomWebView
        injectedJavaScript={PAGE_SHOWN_SCRIPT}
        onMessage={handleMessage}
        ref={webViewRef}
        source={{ uri: pageUrl }}
        style={styles.page}
      />
      <View style={styles.actions}>
        <AppButton
          disabled={!shownHref || isSaving}
          label={isSaving ? "Reading the page..." : "Save recipe"}
          onPress={saveRecipe}
        />
        <AppButton label="Cancel" onPress={() => router.back()} variant="ghost" />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  actions: {
    backgroundColor: appColors.surface,
    borderTopColor: appColors.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: appSpacing.sm,
    padding: appSpacing.lg
  },
  notice: {
    backgroundColor: appColors.surface,
    borderBottomColor: appColors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: appSpacing.lg,
    paddingVertical: appSpacing.md
  },
  noticeText: {
    fontSize: 14,
    lineHeight: 20
  },
  page: {
    backgroundColor: "#ffffff",
    flex: 1
  },
  screen: {
    backgroundColor: appColors.background,
    flex: 1
  }
});
