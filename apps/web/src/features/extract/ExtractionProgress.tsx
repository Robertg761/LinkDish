import React, { useEffect, useMemo, useState } from "react";

import { Button } from "../../components/Button";
import { Icon } from "../../components/Icon";
import { Skeleton } from "../../components/Skeleton";

import {
  formatElapsed,
  getActiveStageIndex,
  getExtractionStages,
  SLOW_IMPORT_MS
} from "./extraction-loading-copy";
import { getImportHost } from "./import-input";

import type { ImportRequest } from "./use-import-session";

interface ExtractionProgressProps {
  request: ImportRequest;
  attempt: "primary" | "fallback";
  /** AI help started by itself (social captions, paid plans). */
  auto: boolean;
  startedAt: number;
  onCancel: () => void;
  /** Offered when a link is slow: stop and paste the recipe text instead. */
  onPasteInstead?: (() => void) | undefined;
}

const usePrefersReducedMotion = (): boolean => {
  const [reduced] = useState(() => {
    try {
      return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch {
      return false;
    }
  });
  return reduced;
};

const useElapsed = (startedAt: number): number => {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(id);
  }, [startedAt]);

  return Math.max(0, now - startedAt);
};

/**
 * "Fetching the page → Reading the recipe → Tidying up", with a skeleton of the recipe card that
 * is on its way, the time so far, a gentle note when it's slower than usual, and a Cancel that
 * really stops the request.
 */
export const ExtractionProgress: React.FC<ExtractionProgressProps> = ({
  request,
  attempt,
  auto,
  startedAt,
  onCancel,
  onPasteInstead
}) => {
  const elapsed = useElapsed(startedAt);
  const reducedMotion = usePrefersReducedMotion();
  const stages = useMemo(() => getExtractionStages(request.kind, attempt), [attempt, request.kind]);
  const activeIndex = getActiveStageIndex(stages, elapsed);
  const active = stages[activeIndex] ?? stages[0];
  const slow = elapsed >= SLOW_IMPORT_MS;
  const host = request.kind === "url" ? getImportHost(request.url) : null;
  const firstPhoto = request.kind === "images" ? request.images[0]?.dataUrl : undefined;
  const sourceLabel =
    request.kind === "images"
      ? `${request.images.length} photo${request.images.length === 1 ? "" : "s"}`
      : request.kind === "text"
        ? "Your text"
        : (host ?? "Your link");

  return (
    <section
      aria-busy="true"
      aria-labelledby="extraction-progress-title"
      className="extraction-progress"
    >
      <div className="extraction-progress-head">
        <span className="extraction-progress-source">
          <Icon
            name={
              request.kind === "images" ? "camera" : request.kind === "text" ? "file-text" : "globe"
            }
            size={15}
          />
          <span className="extraction-progress-source-label">{sourceLabel}</span>
        </span>
        <span className="extraction-progress-elapsed num" aria-label="Time so far">
          {formatElapsed(elapsed)}
        </span>
      </div>

      <h1 aria-live="polite" className="extraction-progress-title" id="extraction-progress-title">
        {active?.label ?? "Getting your recipe"}
        {reducedMotion ? (
          <span aria-hidden="true" className="extraction-progress-dots is-static">
            …
          </span>
        ) : (
          <span aria-hidden="true" className="extraction-progress-dots">
            <span>.</span>
            <span>.</span>
            <span>.</span>
          </span>
        )}
      </h1>
      <p className="extraction-progress-detail">
        {auto && attempt === "fallback"
          ? "This recipe lives in a caption or video, so we’re reading it with AI help."
          : active?.detail}
      </p>

      <ol aria-label="Progress" className="extraction-progress-stages">
        {stages.map((item, index) => {
          const state = index < activeIndex ? "done" : index === activeIndex ? "active" : "todo";

          return (
            <li className={`extraction-progress-stage is-${state}`} key={item.label}>
              <span aria-hidden="true" className="extraction-progress-stage-mark">
                {state === "done" ? <Icon name="check" size={14} strokeWidth={3} /> : null}
              </span>
              <span className="extraction-progress-stage-label">
                <span aria-hidden="true">{item.step}</span>
                <span className="sr-only">{item.label}</span>
                <span className="sr-only">
                  {state === "done" ? " (done)" : state === "active" ? " (in progress)" : ""}
                </span>
              </span>
            </li>
          );
        })}
      </ol>

      {slow ? (
        <p className="extraction-progress-slow" role="status">
          <Icon name="hourglass" size={18} />
          <span>
            <strong>Taking longer than usual…</strong>{" "}
            {attempt === "fallback" || request.kind !== "url"
              ? "AI help is still reading. It’s worth the wait."
              : "Some sites are slow to answer. Hang tight, or paste the recipe text instead."}
          </span>
        </p>
      ) : null}

      <div className="extraction-progress-actions">
        <Button icon="x" onClick={onCancel} variant="secondary">
          Cancel
        </Button>
        {slow && onPasteInstead && request.kind === "url" && attempt === "primary" ? (
          <Button icon="file-text" onClick={onPasteInstead} variant="ghost">
            Paste the text instead
          </Button>
        ) : null}
      </div>

      <div aria-hidden="true" className="extraction-progress-preview">
        <div className="extraction-progress-preview-media">
          {firstPhoto ? (
            <img alt="" className="extraction-progress-preview-photo" src={firstPhoto} />
          ) : (
            <Skeleton className="extraction-progress-preview-image" />
          )}
        </div>
        <div className="extraction-progress-preview-body">
          <Skeleton height={14} radius={999} width="34%" />
          <Skeleton height={28} radius={10} width="88%" />
          <Skeleton height={28} radius={10} width="62%" />
          <div className="extraction-progress-preview-meta">
            <Skeleton height={34} radius={10} width="22%" />
            <Skeleton height={34} radius={10} width="22%" />
            <Skeleton height={34} radius={10} width="22%" />
          </div>
          <div className="extraction-progress-preview-lines">
            {[82, 64, 74, 52].map((width) => (
              <span className="extraction-progress-preview-line" key={width}>
                <Skeleton height={18} shape="circle" width={18} />
                <Skeleton height={12} radius={6} width={`${width}%`} />
              </span>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
};
