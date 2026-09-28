import React, { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { Badge } from "../../components/Badge";
import { Button } from "../../components/Button";
import { Icon } from "../../components/Icon";
import { ProgressBar } from "../../components/ProgressBar";
import { SegmentedControl } from "../../components/SegmentedControl";
import { Sheet } from "../../components/Sheet";
import { getDataTransferErrorMessage } from "../data-transfer/errors";
import { IMPORT_SOURCE_LABELS } from "../data-transfer/import-formats";
import { LOCAL_LIMIT_FREE } from "../library/saved-recipe-store";

import type { IconName } from "../../components/Icon";
import type { SegmentedOption } from "../../components/SegmentedControl";
import type { PreparedImport } from "../data-transfer/data-transfer";
import type { DuplicateMode, ImportPlan } from "../data-transfer/import-plan";
import type { ImportProgress } from "../data-transfer/import-sources";
import type { ImportResult } from "../data-transfer/import-writer";

interface ImportSheetProps {
  file: File | null;
  isPremium: boolean;
  onClose: () => void;
  /** Offer unlimited recipes (the upgrade sheet); called after this sheet closes. */
  onUpgrade: () => void;
  /** Close this sheet and open the file picker again. */
  onChooseAnother: () => void;
}

type Phase =
  | { kind: "reading"; progress: ImportProgress | null }
  | { kind: "error"; message: string }
  | { kind: "preview"; prepared: PreparedImport }
  | { kind: "importing"; prepared: PreparedImport; progress: ImportProgress | null }
  | { kind: "done"; prepared: PreparedImport; result: ImportResult };

const DUPLICATE_OPTIONS: ReadonlyArray<SegmentedOption<DuplicateMode>> = [
  { value: "skip", label: "Skip duplicates" },
  { value: "keep", label: "Keep both" }
];

const loadFlows = () => import("../data-transfer/data-transfer");

const plural = (count: number, one: string, many = `${one}s`): string =>
  `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;

const SummaryRow: React.FC<{
  icon: IconName;
  tone?: "default" | "muted" | "warning" | undefined;
  children: React.ReactNode;
}> = ({ icon, tone = "default", children }) => (
  <li className={`settings-import-row settings-import-row-${tone}`}>
    <span className="settings-import-row-icon" aria-hidden="true">
      <Icon name={icon} size={18} />
    </span>
    <span className="settings-import-row-text">{children}</span>
  </li>
);

const importButtonLabel = (plan: ImportPlan, isBackup: boolean): string => {
  const count = plan.counts.imported + plan.counts.restoredStarters;

  if (count === 0) {
    return isBackup && (plan.mealPlan.length || plan.collections.length)
      ? "Restore plan and collections"
      : "Nothing new to import";
  }

  return isBackup ? `Restore ${plural(count, "recipe")}` : `Import ${plural(count, "recipe")}`;
};

/** "Sep 28, 2026" */
const formatBackupDate = (iso: string): string =>
  new Date(iso).toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" });

const hasAnythingToWrite = (plan: ImportPlan): boolean =>
  plan.recipes.length +
    plan.membershipAdditions.length +
    plan.collections.length +
    plan.mealPlan.length >
  0;

export const ImportSheet: React.FC<ImportSheetProps> = ({
  file,
  isPremium,
  onClose,
  onUpgrade,
  onChooseAnother
}) => {
  const navigate = useNavigate();
  const [phase, setPhase] = useState<Phase>({ kind: "reading", progress: null });
  const [duplicateMode, setDuplicateMode] = useState<DuplicateMode>("skip");
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const flowsRef = useRef<Awaited<ReturnType<typeof loadFlows>> | null>(null);

  // Read and analyze the chosen file.
  useEffect(() => {
    if (!file) {
      return undefined;
    }

    const controller = new AbortController();
    setPhase({ kind: "reading", progress: null });
    setDuplicateMode("skip");
    setShowDetails(false);

    void (async () => {
      try {
        const flows = await loadFlows();
        flowsRef.current = flows;
        const prepared = await flows.prepareImport(file, {
          signal: controller.signal,
          onProgress: (progress) => {
            if (!controller.signal.aborted) {
              setPhase({ kind: "reading", progress });
            }
          }
        });

        if (!controller.signal.aborted) {
          setPhase({ kind: "preview", prepared });
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          setPhase({ kind: "error", message: getDataTransferErrorMessage(error, "read") });
        }
      }
    })();

    return () => controller.abort();
  }, [file]);

  const prepared = phase.kind === "preview" ? phase.prepared : null;

  // Re-plan when the duplicate choice changes (pure and fast).
  useEffect(() => {
    if (prepared && flowsRef.current) {
      setPlan(flowsRef.current.previewImport(prepared, { duplicateMode, isPremium }));
    }
  }, [prepared, duplicateMode, isPremium]);

  const handleImport = async () => {
    if (phase.kind !== "preview" || !flowsRef.current) {
      return;
    }

    const current = phase.prepared;
    setPhase({ kind: "importing", prepared: current, progress: null });

    try {
      const result = await flowsRef.current.runImport(current, {
        duplicateMode,
        isPremium,
        onProgress: (progress) => setPhase({ kind: "importing", prepared: current, progress })
      });
      setPhase({ kind: "done", prepared: current, result });
    } catch (error) {
      setPhase({ kind: "error", message: getDataTransferErrorMessage(error, "write") });
    }
  };

  const handleUpgrade = () => {
    onClose();
    onUpgrade();
  };

  const busy = phase.kind === "importing" || phase.kind === "reading";
  const parsed =
    phase.kind === "preview" || phase.kind === "importing" || phase.kind === "done"
      ? phase.prepared.analysis.parsed
      : null;
  const isBackup = parsed?.source === "linkdish";
  const scannedToWrite = plan?.recipes.filter((recipe) => recipe.sourceImages?.length).length ?? 0;
  const title =
    phase.kind === "done"
      ? "All set"
      : phase.kind === "error"
        ? "We couldn't import that"
        : isBackup
          ? "Restore a backup"
          : "Import recipes";

  const renderFooter = (): React.ReactNode => {
    if (phase.kind === "reading") {
      return (
        <Button onClick={onClose} variant="secondary">
          Cancel
        </Button>
      );
    }

    if (phase.kind === "error") {
      return (
        <Button icon="upload" onClick={onChooseAnother} variant="secondary">
          Choose another file
        </Button>
      );
    }

    if (phase.kind === "done") {
      return (
        <>
          <Button onClick={onClose} variant="secondary">
            Done
          </Button>
          <Button
            onClick={() => {
              onClose();
              void navigate("/");
            }}
          >
            Open cookbook
          </Button>
        </>
      );
    }

    return (
      <>
        <Button disabled={phase.kind === "importing"} onClick={onClose} variant="secondary">
          Cancel
        </Button>
        <Button
          disabled={!plan || !hasAnythingToWrite(plan)}
          loading={phase.kind === "importing"}
          onClick={() => void handleImport()}
        >
          {plan ? importButtonLabel(plan, isBackup) : "Import"}
        </Button>
      </>
    );
  };

  if (!file) {
    return null;
  }

  return (
    <Sheet
      className="settings-import-sheet"
      description={
        parsed ? (
          <span className="settings-import-source">
            <Badge tone="primary">
              {isBackup
                ? parsed.exportedAt
                  ? `Backup from ${formatBackupDate(parsed.exportedAt)}`
                  : "LinkDish backup"
                : parsed.source === "schema_org"
                  ? "Recipe data file"
                  : `From ${IMPORT_SOURCE_LABELS[parsed.source]}`}
            </Badge>
            <span className="settings-import-file" title={parsed.fileName}>
              {parsed.fileName}
            </span>
          </span>
        ) : undefined
      }
      dismissible={!busy || phase.kind === "reading"}
      footer={renderFooter()}
      onClose={onClose}
      open
      size="md"
      testId="import-sheet"
      title={title}
    >
      {phase.kind === "reading" ? (
        <div className="settings-import-status" role="status">
          <Icon className="settings-import-spinner" name="loader" size={22} />
          <p>
            {phase.progress && phase.progress.total > 1
              ? `Reading recipe ${Math.min(phase.progress.done + 1, phase.progress.total)} of ${phase.progress.total}…`
              : `Reading ${file.name}…`}
          </p>
          <p className="settings-import-muted">
            Everything stays on this device — nothing is uploaded.
          </p>
        </div>
      ) : null}

      {phase.kind === "error" ? (
        <div className="settings-import-error" role="alert">
          <span className="settings-import-error-icon" aria-hidden="true">
            <Icon name="alert-circle" size={22} />
          </span>
          <p>{phase.message}</p>
        </div>
      ) : null}

      {(phase.kind === "preview" || phase.kind === "importing") && parsed && plan ? (
        <>
          <div className="settings-import-hero">
            <span className="settings-import-hero-count num">{parsed.candidates.length}</span>
            <span className="settings-import-hero-label">
              {parsed.candidates.length === 1 ? "recipe found" : "recipes found"}
            </span>
          </div>

          <ul className="settings-import-summary">
            {plan.counts.duplicates > 0 ? (
              <SummaryRow icon="copy" tone="muted">
                {plan.counts.duplicates.toLocaleString("en-US")}{" "}
                {plan.counts.duplicates === 1 ? "is" : "are"} already in your cookbook
              </SummaryRow>
            ) : (
              <SummaryRow icon="check-circle">None of them are in your cookbook yet</SummaryRow>
            )}
            {plan.counts.restoredStarters > 0 ? (
              <SummaryRow icon="sparkles">
                {plural(plan.counts.restoredStarters, "starter recipe")} with your notes and ratings
              </SummaryRow>
            ) : null}
            {isBackup && parsed.collections.length > 0 ? (
              <SummaryRow
                icon="folder"
                tone={plan.counts.collectionsCreated === 0 ? "muted" : "default"}
              >
                {plural(parsed.collections.length, "collection")}
                {plan.counts.collectionsCreated === 0
                  ? ", already here"
                  : plan.counts.collectionsMatched > 0
                    ? ` (${plan.counts.collectionsMatched} already here)`
                    : ""}
              </SummaryRow>
            ) : null}
            {isBackup && parsed.mealPlan.length > 0 ? (
              <SummaryRow
                icon="calendar-days"
                tone={plan.counts.mealPlanAdded === 0 ? "muted" : "default"}
              >
                {plan.counts.mealPlanAdded === 0
                  ? `${plural(parsed.mealPlan.length, "planned meal")}, already in your plan`
                  : `${plural(plan.counts.mealPlanAdded, "planned meal")} to add${
                      plan.counts.mealPlanSkipped > 0
                        ? ` (${plan.counts.mealPlanSkipped} already planned)`
                        : ""
                    }`}
              </SummaryRow>
            ) : null}
            {scannedToWrite > 0 ? (
              <SummaryRow icon="images">
                Original scans for {plural(scannedToWrite, "recipe")}
              </SummaryRow>
            ) : null}
            {parsed.photosSkipped > 0 ? (
              <SummaryRow icon="image" tone="muted">
                Photos stored inside the file aren't copied. Recipes keep their web photo when they
                have one.
              </SummaryRow>
            ) : null}
            {parsed.unreadable > 0 ? (
              <SummaryRow icon="alert-triangle" tone="warning">
                {plural(parsed.unreadable, "recipe")} couldn't be read and will be left out
              </SummaryRow>
            ) : null}
          </ul>

          {parsed.warnings.length > 0 ? (
            <div className="settings-import-details">
              <button
                aria-expanded={showDetails}
                className="settings-import-details-toggle"
                onClick={() => setShowDetails((current) => !current)}
                type="button"
              >
                <Icon name={showDetails ? "chevron-up" : "chevron-down"} size={16} />
                {showDetails ? "Hide details" : `Show details (${parsed.warnings.length})`}
              </button>
              {showDetails ? (
                <ul className="settings-import-warnings">
                  {parsed.warnings.map((warning, index) => (
                    <li key={`${index}-${warning}`}>{warning}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}

          {plan.counts.duplicates > 0 ? (
            <div className="settings-import-choice">
              <span className="settings-import-choice-label" id="import-duplicates-label">
                Recipes you already have
              </span>
              <SegmentedControl
                aria-label="Recipes you already have"
                fullWidth
                onChange={setDuplicateMode}
                options={DUPLICATE_OPTIONS}
                size="sm"
                value={duplicateMode}
              />
              <span className="settings-import-muted">
                {duplicateMode === "skip"
                  ? "Your copies stay exactly as they are."
                  : "A second copy is added next to each one you already have."}
              </span>
            </div>
          ) : null}

          {plan.counts.overLimit > 0 ? (
            <div className="settings-import-limit" role="note">
              <Icon name="crown" size={18} />
              <div className="settings-import-limit-copy">
                <strong>
                  {plan.remainingFreeSlots === 0
                    ? "Your free cookbook is full"
                    : `Room for ${plural(plan.remainingFreeSlots, "more recipe")} on the free plan`}
                </strong>
                <span>
                  Free cookbooks hold {LOCAL_LIMIT_FREE} of your own recipes (starter recipes don't
                  count).{" "}
                  {plan.remainingFreeSlots === 0
                    ? `Upgrade to bring in all ${plan.counts.overLimit}.`
                    : `We'll import the first ${plan.remainingFreeSlots}. Upgrade to bring in all ${plan.remainingFreeSlots + plan.counts.overLimit}.`}
                </span>
                <Button icon="sparkles" onClick={handleUpgrade} size="sm" variant="tonal">
                  Get unlimited recipes
                </Button>
              </div>
            </div>
          ) : null}

          {phase.kind === "importing" ? (
            <ProgressBar
              label="Import progress"
              max={phase.progress?.total || 1}
              value={phase.progress?.done ?? 0}
              valueText={
                phase.progress
                  ? `Saved ${phase.progress.done} of ${phase.progress.total}`
                  : "Starting"
              }
            />
          ) : null}
        </>
      ) : null}

      {phase.kind === "done" ? (
        <div className="settings-import-done" role="status">
          <span className="settings-import-done-icon" aria-hidden="true">
            <Icon name="check" size={28} strokeWidth={2.6} />
          </span>
          <p className="settings-import-done-title">
            {phase.result.plan.counts.imported + phase.result.plan.counts.restoredStarters > 0
              ? `${plural(phase.result.plan.counts.imported + phase.result.plan.counts.restoredStarters, "recipe")} ${isBackup ? "restored" : "added to your cookbook"}`
              : isBackup
                ? "Your backup is restored"
                : "Your cookbook is up to date"}
          </p>
          <ul className="settings-import-summary">
            {phase.result.plan.counts.skippedDuplicates > 0 ? (
              <SummaryRow icon="copy" tone="muted">
                {plural(phase.result.plan.counts.skippedDuplicates, "duplicate")} skipped
              </SummaryRow>
            ) : null}
            {phase.result.plan.counts.keptDuplicates > 0 ? (
              <SummaryRow icon="copy" tone="muted">
                {plural(phase.result.plan.counts.keptDuplicates, "second copy", "second copies")}{" "}
                added
              </SummaryRow>
            ) : null}
            {phase.result.plan.counts.collectionsCreated > 0 ? (
              <SummaryRow icon="folder">
                {plural(phase.result.plan.counts.collectionsCreated, "collection")} added
              </SummaryRow>
            ) : null}
            {phase.result.plan.counts.mealPlanAdded > 0 ? (
              <SummaryRow icon="calendar-days">
                {plural(phase.result.plan.counts.mealPlanAdded, "planned meal")} added
              </SummaryRow>
            ) : null}
          </ul>
          {phase.result.plan.counts.overLimit > 0 ? (
            <div className="settings-import-limit" role="note">
              <Icon name="crown" size={18} />
              <div className="settings-import-limit-copy">
                <strong>
                  {plural(phase.result.plan.counts.overLimit, "recipe")} didn't fit in your free
                  cookbook
                </strong>
                <span>
                  Upgrade for unlimited recipes, then import the same file again — the recipes you
                  already have are skipped automatically.
                </span>
                <Button icon="sparkles" onClick={handleUpgrade} size="sm" variant="accent">
                  Get unlimited recipes
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </Sheet>
  );
};
