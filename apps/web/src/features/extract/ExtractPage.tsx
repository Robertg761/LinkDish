import { extractFirstUrl } from "@linkdish/recipe-domain";
import React, { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";

import { trackWebEvent, trackWebV2AnalyticsEvent } from "../../analytics/client";
import { getFriendlyErrorMessage } from "../../api/error-message";
import { isCachedUserPremium } from "../../auth/auth-cache";
import { useAuth } from "../../auth/AuthProvider";
import { Icon } from "../../components/Icon";
import { LoadingState } from "../../components/LoadingState";
import { SegmentedControl } from "../../components/SegmentedControl";
import { useToast } from "../../components/Toast";
import {
  enqueueImports,
  removeImportQueueItem,
  type ImportQueueItem
} from "../../data/import-queue-store";
import { useDocumentTitle } from "../../lib/use-document-title";
import { RAIL_MEDIA_QUERY, useMediaQuery } from "../../lib/use-media-query";
import { addNetworkListeners, isOnline } from "../../platform/detect-network";
import { lazyWithRetry } from "../../platform/lazy";
import { OptionalChunkBoundary } from "../../platform/OptionalChunkBoundary";
import { ImportQueuePanel } from "../import-queue/ImportQueuePanel";
import { useImportQueueRunner } from "../import-queue/use-import-queue-runner";
import { InstallPrompt } from "../install/InstallPrompt";
import { saveRecipe } from "../library/saved-recipe-store";
import { useUpgradeSheet } from "../upgrade/UpgradeSheet";

import { ExtractionProgress } from "./ExtractionProgress";
import { clearImportDraft, readImportDraft, writeImportDraft } from "./import-draft";
import { createImageImportSourceUrl } from "./import-input";
import { IMPORT_ANALYTICS_ROUTE } from "./import-shared";
import { ImportLinkPanel } from "./ImportLinkPanel";
import { DuplicateCard, ImportProblemCard, NeedsRetryCard, QueuedCard } from "./ImportOutcomeCards";
import { ImportTextPanel } from "./ImportTextPanel";
import { RecentImports } from "./RecentImports";
import { SupportedSources } from "./SupportedSources";
import { useImportSession } from "./use-import-session";
import { formatImportUsage, useImportUsage } from "./use-import-usage";
import { getImportSourceType } from "./use-save-import";

import type { ImportDraft } from "./import-draft";
import type { ImportActionId } from "./import-outcome";
import type { ImportPhase } from "./use-import-session";
import type { ImportUsage } from "./use-import-usage";
import type { SegmentedOption } from "../../components/SegmentedControl";

import "./ExtractPage.css";

/*
 * The result view (with the whole recipe layout) and the photo picker load on demand: the
 * result starts downloading as soon as an import begins, the photos panel when the page is idle.
 */
const ExtractResult = lazyWithRetry(() =>
  import("./ExtractResult").then((module) => ({ default: module.ExtractResult }))
);
const ImportPhotoPanel = lazyWithRetry(() =>
  import("./ImportPhotoPanel").then((module) => ({ default: module.ImportPhotoPanel }))
);

/** True from the first time `value` is true (keeps a panel mounted once it has been opened). */
const useLatch = (value: boolean): boolean => {
  const [latched, setLatched] = useState(value);

  useEffect(() => {
    if (value) {
      setLatched(true);
    }
  }, [value]);

  return latched || value;
};

const preload = (component: { preload: () => Promise<unknown> }) => {
  void component.preload().catch(() => undefined);
};

type ComposerMode = "link" | "text" | "photos";

/* Short labels, so the control fits a 360px phone without cutting "Paste t…". */
const MODE_OPTIONS: ReadonlyArray<SegmentedOption<ComposerMode>> = [
  { icon: "link", label: "Link", value: "link" },
  { icon: "file-text", label: "Text", value: "text" },
  { icon: "camera", label: "Photos", value: "photos" }
];

/** The lockup follows the mode: the promise of each way in, in the site's voice. */
const HERO_COPY: Record<ComposerMode, { title: string; accent: string; lede: string }> = {
  link: {
    accent: "Get cooking.",
    lede: "From any recipe site, a video or a caption. LinkDish keeps just the recipe.",
    title: "Paste a link."
  },
  photos: {
    accent: "We'll type it up.",
    lede: "A cookbook page, a magazine clipping or a handwritten card. LinkDish reads the photo and keeps the recipe.",
    title: "Snap the page."
  },
  text: {
    accent: "We'll tidy it up.",
    lede: "From a caption, an email or your notes. LinkDish sorts out the ingredients and the steps.",
    title: "Paste the recipe."
  }
};

interface ShareParams {
  present: boolean;
  url: string | null;
  text: string | null;
  tab: ComposerMode | null;
}

/** ?url= / ?text= from the share target (or links into the importer), plus ?tab=. */
const readShareParams = (params: URLSearchParams): ShareParams => {
  const urlParam = params.get("url")?.trim() ?? "";
  const textParam = params.get("text")?.trim() ?? "";
  const titleParam = params.get("title")?.trim() ?? "";
  const tabParam = params.get("tab");
  const url =
    extractFirstUrl(urlParam) ?? extractFirstUrl(textParam) ?? extractFirstUrl(titleParam) ?? null;
  const text = !url && textParam ? textParam : null;

  return {
    present: Boolean(urlParam || textParam || titleParam),
    tab: tabParam === "text" || tabParam === "photos" || tabParam === "link" ? tabParam : null,
    text,
    url
  };
};

const ImportUsageChip: React.FC<{ usage: ImportUsage }> = ({ usage }) => {
  const low = usage.remaining <= 1;

  return (
    <p className={`extract-usage${usage.remaining === 0 ? " is-empty" : low ? " is-low" : ""}`}>
      <Icon name="sparkles" size={14} />
      <span className="num">{formatImportUsage(usage)}</span>
      {usage.remaining === 0 ? (
        <Link className="extract-usage-link" to="/pricing">
          See plans
        </Link>
      ) : null}
    </p>
  );
};

/**
 * /import — "Paste a link. Get cooking." Links, pasted text and photos go in; a staged,
 * cancellable import runs; the recipe comes out ready to save and cook. Several links at once
 * (or anything shared while offline) wait in the import queue.
 */
export const ExtractPage: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const { isAuthenticated } = useAuth();
  const { requestUpgradeSheet } = useUpgradeSheet();
  const { showToast } = useToast();
  const isDesktop = useMediaQuery(RAIL_MEDIA_QUERY);
  const session = useImportSession();
  const runner = useImportQueueRunner();
  const { phase } = session;
  const [initialShare] = useState(() => readShareParams(searchParams));
  const [mode, setMode] = useState<ComposerMode>(
    () => initialShare.tab ?? (initialShare.text ? "text" : "link")
  );
  const [text, setText] = useState(() => initialShare.text ?? "");
  const [focusRequest, setFocusRequest] = useState(0);
  const [offline, setOffline] = useState(() => !isOnline());
  const [usageVersion, setUsageVersion] = useState(0);
  const [restoredDraft, setRestoredDraft] = useState(false);
  const photosOpened = useLatch(mode === "photos");
  const usage = useImportUsage(session.quota, usageVersion);
  const savedRef = useRef(false);
  const phaseRef = useRef<ImportPhase>(phase);
  phaseRef.current = phase;
  /** The navigation (location.key) whose ?url= / ?text= / ?tab= was already acted on. */
  const handledShareKeyRef = useRef<string | null>(null);
  const sessionRef = useRef(session);
  sessionRef.current = session;

  useDocumentTitle(phase.status === "success" ? null : "Add a recipe");

  useEffect(() => {
    if (phase.status === "extracting" || phase.status === "success") {
      preload(ExtractResult);
    }
  }, [phase.status]);

  useEffect(() => {
    const idle = window.requestIdleCallback;
    const warm = () => preload(ImportPhotoPanel);

    if (typeof idle === "function") {
      const id = idle(warm, { timeout: 4000 });
      return () => window.cancelIdleCallback?.(id);
    }

    const timer = window.setTimeout(warm, 2000);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(
    () =>
      addNetworkListeners({
        onOffline: () => setOffline(true),
        onOnline: () => setOffline(false)
      }),
    []
  );

  // Share target, links into the importer and in-app links (the command palette, onboarding):
  // act on ?url= / ?text= / ?tab= whenever a navigation brings them, also when the importer is
  // already open, then clear the address bar so a reload never spends another import.
  useEffect(() => {
    const share = readShareParams(new URLSearchParams(location.search));

    if ((!share.present && !share.tab) || handledShareKeyRef.current === location.key) {
      return;
    }

    const timer = window.setTimeout(() => {
      handledShareKeyRef.current = location.key;
      void navigate({ pathname: "/import", search: "" }, { replace: true });

      if (share.url) {
        // A fresh page load is the OS share sheet (or a bookmarklet); in-app links carry a key.
        const source = location.key === "default" ? "share_sheet" : "in_app";
        void sessionRef.current.startUrl(share.url, { source });
        return;
      }

      if (phaseRef.current.status !== "idle") {
        // Back to the composer (an unsaved result stays in the session draft).
        sessionRef.current.reset();
        setRestoredDraft(false);
      }

      if (share.text) {
        setText(share.text);
      }

      const nextMode = share.tab ?? (share.text ? "text" : null);

      if (nextMode) {
        setMode(nextMode);
        setFocusRequest((request) => request + 1);
      }
    }, 0);

    return () => window.clearTimeout(timer);
  }, [location.key, location.search, navigate]);

  // An unsaved import from earlier in this session comes back instead of being lost.
  useEffect(() => {
    if (initialShare.url) {
      return;
    }

    const draft = readImportDraft();

    if (draft) {
      setRestoredDraft(true);
      session.restore({
        attempt: draft.attempt,
        correlationId: draft.correlationId,
        request: draft.request,
        response: draft.response,
        status: "success"
      });
    }
    // Only when the page first opens.
  }, []);

  // Keep the unsaved result as a draft; bump the usage counter after each import.
  useEffect(() => {
    if (phase.status === "success") {
      setUsageVersion((version) => version + 1);

      if (!savedRef.current) {
        writeImportDraft({
          attempt: phase.attempt,
          correlationId: phase.correlationId,
          request: phase.request,
          response: phase.response
        });
      }
    } else {
      savedRef.current = false;
    }
  }, [phase]);

  // Closing the tab on an unsaved import asks first (in-app navigation keeps the draft).
  const unsaved = phase.status === "success";
  useEffect(() => {
    if (!unsaved) {
      return;
    }

    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!savedRef.current) {
        event.preventDefault();
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [unsaved]);

  // Leaving the Add tab with an unsaved import: offer to save it from wherever the cook goes.
  const saveDraftFromToast = useCallback(
    async (draft: ImportDraft) => {
      const request = draft.request;
      const input = {
        extraction: {
          fetchMode: draft.response.extraction.fetchMode,
          provenance: draft.response.extraction.provenance,
          strategy: draft.response.extraction.strategy,
          warnings: draft.response.extraction.warnings
        },
        recipe: draft.response.recipe,
        sourceImages:
          request.kind === "images" && request.images.length ? request.images : undefined,
        sourceUrl:
          request.kind === "url"
            ? request.url
            : request.kind === "images"
              ? request.sourceUrl
              : (request.sourceUrl ?? draft.response.recipe.sourceUrl)
      };

      try {
        const result = await saveRecipe(input, isCachedUserPremium());

        if (result.error === "limit_exceeded") {
          requestUpgradeSheet("save_limit");
          showToast({ message: "Your free cookbook is full.", tone: "danger" });
          return;
        }

        clearImportDraft();
        const id = result.recipe?.id;

        if (result.success) {
          trackWebV2AnalyticsEvent({
            name: "recipe_saved",
            properties: { source_type: getImportSourceType(input), surface: "import_result" },
            routeOrScreen: IMPORT_ANALYTICS_ROUTE
          });
        }

        showToast({
          ...(id
            ? { action: { label: "Open", onClick: () => void navigate(`/recipes/${id}`) } }
            : {}),
          icon: "check-circle",
          message: result.success
            ? `Saved “${draft.response.recipe.title}” to your cookbook.`
            : "That recipe is already in your cookbook.",
          tone: "success"
        });
      } catch (error) {
        showToast({ message: getFriendlyErrorMessage(error, "save"), tone: "danger" });
      }
    },
    [navigate, requestUpgradeSheet, showToast]
  );

  useEffect(
    () => () => {
      const current = phaseRef.current;

      if (current.status !== "success" || savedRef.current) {
        return;
      }

      const draft = readImportDraft();

      if (draft) {
        showToast({
          action: { label: "Save", onClick: () => void saveDraftFromToast(draft) },
          duration: 9000,
          icon: "bookmark-plus",
          id: "import-unsaved",
          message: `“${current.response.recipe.title}” isn’t saved yet.`
        });
      }
    },
    // Reads refs on unmount only.
    []
  );

  /* ---------------------------------------- actions ----------------------------------------- */

  const switchMode = useCallback((next: ComposerMode) => {
    setMode(next);
    setFocusRequest((request) => request + 1);
  }, []);

  const backTo = useCallback(
    (next: ComposerMode) => {
      session.reset();
      clearImportDraft();
      setRestoredDraft(false);
      switchMode(next);
    },
    [session, switchMode]
  );

  const handleAction = (action: ImportActionId) => {
    switch (action) {
      case "retry":
        session.retry();
        return;
      case "retry_ai":
        if (phase.status === "needs_retry") {
          void session.runFallback();
        } else if (phase.status === "problem" && phase.request?.kind === "url") {
          void session.startUrl(phase.request.url, {
            attempt: "fallback",
            skipDuplicateCheck: true
          });
        }
        return;
      case "paste_text":
      case "edit_text":
        backTo("text");
        return;
      case "scan_photo":
      case "change_photos":
        backTo("photos");
        return;
      case "another_link":
        backTo("link");
        return;
      case "see_plans":
        void navigate("/pricing");
    }
  };

  const importMany = async (urls: string[]) => {
    try {
      const items = await enqueueImports(urls.map((url) => ({ source: "in_app", url })));

      if (!isOnline()) {
        trackWebEvent({
          eventName: "import_queued_offline",
          properties: { item_count: items.length, source: "in_app", source_type: "url" },
          routeOrScreen: IMPORT_ANALYTICS_ROUTE
        });
      }

      showToast({
        icon: "list-checks",
        message: isOnline()
          ? `${items.length} recipes added to your import queue.`
          : `You’re offline. ${items.length} recipes will import when you’re back.`,
        tone: "success"
      });
    } catch (error) {
      showToast({ message: getFriendlyErrorMessage(error, "save"), tone: "danger" });
    }
  };

  const openQueueItem = (item: ImportQueueItem) => {
    if (!item.url) {
      return;
    }

    const url = item.url;
    // Out of the queue first: should another tab have retried it and be importing it by now, the
    // queue keeps it, and opening it here too would import (and spend) it twice.
    void removeImportQueueItem(item.id).then(
      (removed) => {
        if (removed) {
          void session.startUrl(url);
        } else {
          showToast({ message: "That one’s importing already." });
        }
      },
      () => showToast({ message: "That couldn’t be opened.", tone: "danger" })
    );
  };

  const startOver = () => {
    session.reset();
    clearImportDraft();
    setRestoredDraft(false);
  };

  /* ----------------------------------------- render ----------------------------------------- */

  if (phase.status === "success") {
    const { request, response } = phase;
    const sourceUrl =
      request.kind === "url"
        ? request.url
        : request.kind === "images"
          ? request.sourceUrl
          : (request.sourceUrl ?? response.recipe.sourceUrl);

    return (
      <Suspense fallback={<LoadingState message="Plating your recipe…" variant="recipe" />}>
        <ExtractResult
          confidenceScore={response.extraction.confidenceScore}
          extraction={{
            fetchMode: response.extraction.fetchMode,
            provenance: response.extraction.provenance,
            strategy: response.extraction.strategy,
            warnings: response.extraction.warnings
          }}
          key={phase.correlationId}
          missingFields={response.extraction.missingFields}
          notice={
            restoredDraft ? (
              <p className="extract-restored" role="status">
                <Icon name="bookmark-plus" size={18} />
                This recipe was waiting for you. Save it so it doesn’t get away.
              </p>
            ) : null
          }
          onDiscard={() => clearImportDraft()}
          onReset={startOver}
          onSaved={() => {
            savedRef.current = true;
            clearImportDraft();
            setRestoredDraft(false);
          }}
          recipe={response.recipe}
          sourceImages={
            request.kind === "images" && request.images.length ? request.images : undefined
          }
          sourceUrl={sourceUrl}
        />
      </Suspense>
    );
  }

  const focused = (content: React.ReactNode) => (
    <div className="extract-page extract-page-focused page-enter">
      <div className="extract-focused">{content}</div>
    </div>
  );

  if (phase.status === "extracting") {
    return focused(
      <ExtractionProgress
        attempt={phase.attempt}
        auto={phase.auto}
        onCancel={session.cancel}
        onPasteInstead={() => {
          session.cancel();
          switchMode("text");
        }}
        request={phase.request}
        startedAt={phase.startedAt}
      />
    );
  }

  if (phase.status === "needs_retry") {
    return focused(
      <NeedsRetryCard
        metered={!isAuthenticated || usage !== null}
        onAnotherLink={() => backTo("link")}
        onPasteText={() => backTo("text")}
        onRetryWithAi={() => void session.runFallback()}
        response={phase.response}
        url={phase.request.url}
      />
    );
  }

  if (phase.status === "problem") {
    return focused(
      <ImportProblemCard
        onAction={handleAction}
        onStartOver={startOver}
        problem={phase.problem}
        url={phase.request?.kind === "url" ? phase.request.url : null}
      />
    );
  }

  if (phase.status === "duplicate") {
    return focused(
      <DuplicateCard
        existing={phase.existing}
        onAnotherLink={() => backTo("link")}
        onImportAgain={() => void session.startUrl(phase.request.url, { skipDuplicateCheck: true })}
        onOpen={() => void navigate(`/recipes/${phase.existing.id}`)}
      />
    );
  }

  if (phase.status === "queued") {
    return focused(
      <>
        <QueuedCard item={phase.item} onDone={startOver} />
        <ImportQueuePanel onOpenItem={openQueueItem} runner={runner} />
      </>
    );
  }

  const hero = HERO_COPY[mode];

  // Offline, the app-wide banner already says so; the importer only changes its button to say
  // what will happen ("Save for when you're online").
  return (
    <div className="extract-page page-enter">
      <div className="extract-layout">
        <div className="extract-main">
          <header className="extract-hero">
            <div className="extract-hero-top">
              <p className="extract-eyebrow">Add a recipe</p>
              {usage ? <ImportUsageChip usage={usage} /> : null}
            </div>
            <h1 className="extract-title">
              {hero.title} <em className="extract-title-accent">{hero.accent}</em>
            </h1>
            <p className="extract-lede">{hero.lede}</p>
          </header>

          <div className="extract-composer">
            <SegmentedControl
              aria-label="How to add a recipe"
              className="extract-modes"
              fullWidth
              onChange={switchMode}
              options={MODE_OPTIONS}
              value={mode}
            />
            <div className="extract-panel" hidden={mode !== "link"}>
              <ImportLinkPanel
                autoFocus={isDesktop && !initialShare.present && mode === "link"}
                focusRequest={mode === "link" ? focusRequest : undefined}
                offline={offline}
                onImport={(url) => void session.startUrl(url)}
                onImportMany={(urls) => void importMany(urls)}
                onPasteText={(pasted) => {
                  setText(pasted);
                  switchMode("text");
                  showToast({
                    icon: "file-text",
                    message: "No link on your clipboard, so we put your text in Text."
                  });
                }}
              />
            </div>
            <div className="extract-panel" hidden={mode !== "text"}>
              <ImportTextPanel
                focusRequest={mode === "text" ? focusRequest : undefined}
                onChange={setText}
                onImport={(value, options) => void session.startText(value, options)}
                onImportLink={(url) => void session.startUrl(url)}
                value={text}
              />
            </div>
            <div className="extract-panel" hidden={mode !== "photos"}>
              {photosOpened ? (
                <OptionalChunkBoundary name="Photo import">
                  <Suspense fallback={<LoadingState message="Getting the camera ready…" />}>
                    <ImportPhotoPanel
                      focusRequest={mode === "photos" ? focusRequest : undefined}
                      onImport={(images) =>
                        void session.startImages(images, createImageImportSourceUrl())
                      }
                    />
                  </Suspense>
                </OptionalChunkBoundary>
              ) : null}
            </div>
          </div>

          {/* Phones: the queue sits right under the field it was filled from. */}
          {isDesktop ? null : <ImportQueuePanel onOpenItem={openQueueItem} runner={runner} />}

          {mode === "link" ? <SupportedSources /> : null}
        </div>

        <aside aria-label="Your imports" className="extract-aside">
          {isDesktop ? <ImportQueuePanel onOpenItem={openQueueItem} runner={runner} /> : null}
          <RecentImports />
          <InstallPrompt />
        </aside>
      </div>
    </div>
  );
};
