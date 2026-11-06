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
  isChallengeTitle,
  isSameSitePublicPage,
  pageProblemMessage,
  pageSiteLabel,
  prepareCapturedPage,
  readPageViewMessage,
  resolvePageSite,
  unwrapFacebookLinkWrapper
} from "../src/services/device-page";
import { appColors, appSpacing } from "../src/theme/tokens";

/* The page answers a capture at once; past this, something in it is stuck. */
const CAPTURE_TIMEOUT_MS = 10_000;
/* A loaded page gets a moment to settle before it is read. */
const AUTO_SAVE_DELAY_MS = 1_200;
/* A page that loaded but read as empty is read again a few times before giving up. */
const MAX_EMPTY_RETRIES = 2;
const EMPTY_RETRY_DELAY_MS = 2_000;

const readFirstParam = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

const newNonce = (): string => `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;

/**
 * A recipe site that blocks LinkDish's servers, opened on screen in an in-app browser view right
 * after the person pastes the link. The page loads in front of them, as in any browser (they
 * answer any check the site shows them there). Once the recipe page itself has loaded, the app
 * reads that page, sends it to be imported and moves on to the recipe. If that doesn't work out,
 * a Save recipe button lets them try once the page looks right.
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
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const emptyRetriesRef = useRef(0);
  const isDoneRef = useRef(false);
  /* The site a saved page must be on (a shortened link's destination once it shows). */
  const pageSiteRef = useRef<string | null>(null);
  const [shownHref, setShownHref] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isChecking, setIsChecking] = useState(false);
  /* Set once saving on its own has not worked: the person can then tap Save recipe. */
  const [problem, setProblem] = useState<string | null>(null);

  const clearTimer = (timerRef: { current: ReturnType<typeof setTimeout> | null }) => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const stopWaiting = useCallback(() => {
    captureNonceRef.current = null;
    clearTimer(captureTimerRef);
    setIsSaving(false);
  }, []);

  useEffect(
    () => () => {
      clearTimer(captureTimerRef);
      clearTimer(autoSaveTimerRef);
    },
    []
  );

  const capturePage = useCallback(() => {
    if (isDoneRef.current) {
      return;
    }

    const nonce = newNonce();

    captureNonceRef.current = nonce;
    setIsSaving(true);
    clearTimer(captureTimerRef);
    captureTimerRef.current = setTimeout(() => {
      stopWaiting();
      setProblem("LinkDish couldn't read this page. When the recipe shows, tap Save recipe.");
    }, CAPTURE_TIMEOUT_MS);
    webViewRef.current?.injectJavaScript(buildCaptureScript(nonce));
  }, [stopWaiting]);

  const scheduleCapture = useCallback(
    (delayMs: number) => {
      clearTimer(autoSaveTimerRef);
      autoSaveTimerRef.current = setTimeout(() => {
        autoSaveTimerRef.current = null;
        capturePage();
      }, delayMs);
    },
    [capturePage]
  );

  const saveRecipe = useCallback(() => {
    setProblem(null);
    emptyRetriesRef.current = MAX_EMPTY_RETRIES;
    capturePage();
  }, [capturePage]);

  const handleMessage = useCallback(
    (event: { nativeEvent: { data: string } }) => {
      const message = readPageViewMessage(event.nativeEvent.data);

      if (!message || !pageUrl || isDoneRef.current) {
        return;
      }

      if (message.kind === "shown") {
        pageSiteRef.current = resolvePageSite(pageUrl, pageSiteRef.current, message.href);
        setShownHref(message.href);
        const checking = isChallengeTitle(message.title);
        setIsChecking(checking);

        /* Each new page that loads on the site is read on its own; a check page is waited out. */
        if (
          !checking &&
          pageSiteRef.current &&
          isSameSitePublicPage(pageSiteRef.current, message.href)
        ) {
          emptyRetriesRef.current = 0;
          setProblem(null);
          scheduleCapture(AUTO_SAVE_DELAY_MS);
        }

        return;
      }

      if (!captureNonceRef.current || message.nonce !== captureNonceRef.current) {
        return;
      }

      stopWaiting();
      const pageSite = resolvePageSite(pageUrl, pageSiteRef.current, null) ?? pageUrl;
      const prepared = prepareCapturedPage(pageSite, { href: message.href, html: message.html });

      if ("problem" in prepared) {
        if (prepared.problem === "challenge") {
          /* The site is checking the visit; the page it lets through will load and be read. */
          setIsChecking(true);
          return;
        }

        if (prepared.problem === "empty" && emptyRetriesRef.current < MAX_EMPTY_RETRIES) {
          emptyRetriesRef.current += 1;
          scheduleCapture(EMPTY_RETRY_DELAY_MS);
          return;
        }

        setProblem(pageProblemMessage(prepared.problem, pageSite));
        return;
      }

      isDoneRef.current = true;
      clearTimer(autoSaveTimerRef);
      const pendingImport = createPendingPageImport(message.href, prepared.page);
      router.replace({
        pathname: "/recipe",
        params: { pageImportId: pendingImport.id, url: pendingImport.url }
      });
    },
    [pageUrl, scheduleCapture, stopWaiting]
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

  const site = pageSiteLabel(pageSiteRef.current ?? pageUrl);
  const notice =
    problem ??
    (isChecking
      ? `${site} is checking the visit. If it asks you something, answer it and LinkDish carries on.`
      : isSaving
        ? `Reading the recipe from ${site}...`
        : `${site} doesn't let LinkDish's servers in, so it opens here. LinkDish saves the recipe as soon as the page loads.`);

  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <View style={styles.notice}>
        <AppText muted style={styles.noticeText}>
          {notice}
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
        {problem ? (
          <AppButton
            disabled={!shownHref || isSaving}
            label={isSaving ? "Reading the page..." : "Save recipe"}
            onPress={saveRecipe}
          />
        ) : null}
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
