import { getFriendlyErrorMessage, getServerErrorMessage, isOffline } from "../../api/error-message";
import { getApiErrorKind, isExtractorApiError } from "../../api/errors";
import { formatMonthlyQuotaCopy, hasMonthlyQuotaFields } from "../billing/quota-copy";

import type { IconName } from "../../components/Icon";
import type { WebBillingTier } from "../billing/web-billing";
import type {
  ExtractRecipeFailure,
  ExtractRecipeNeedsRetry,
  QuotaStatus,
  Recovery
} from "@linkdish/api-contracts";

/**
 * Plain-language outcomes for every way an import can go sideways: the server's failure reason
 * and suggested recovery become a specific headline, one sentence and the next steps that
 * actually help (retry the same link, paste the text, scan a photo, try another link). A
 * provider running out of capacity is never mistaken for the person's own plan limit.
 */

export type ImportKind = "url" | "text" | "images";

export type ImportActionId =
  | "retry"
  | "retry_ai"
  | "paste_text"
  | "scan_photo"
  | "another_link"
  | "edit_text"
  | "change_photos"
  | "see_plans";

export const IMPORT_ACTION_LABELS: Record<ImportActionId, string> = {
  another_link: "Try another link",
  change_photos: "Choose other photos",
  edit_text: "Edit the text",
  paste_text: "Paste the recipe text",
  retry: "Try again",
  retry_ai: "Try with AI help",
  scan_photo: "Scan a photo instead",
  see_plans: "See plans"
};

export const IMPORT_ACTION_ICONS: Record<ImportActionId, IconName> = {
  another_link: "link",
  change_photos: "images",
  edit_text: "pencil",
  paste_text: "file-text",
  retry: "refresh",
  retry_ai: "wand",
  scan_photo: "camera",
  see_plans: "sparkles"
};

export type ImportProblemKind =
  | "plan_limit"
  | "allowance_check"
  | "capacity"
  | "offline"
  | "network"
  | "timeout"
  | "rate_limited"
  | "unreachable"
  | "blocked"
  | "unsupported"
  | "not_found"
  | "ai_unavailable"
  | "ai_failed"
  | "too_large"
  | "invalid"
  | "server";

export interface ImportProblem {
  kind: ImportProblemKind;
  title: string;
  message: string;
  /** A quieter second line, e.g. "0 of 100 left this month · resets Oct 1". */
  detail?: string | undefined;
  /** Next steps, most helpful first. */
  actions: ImportActionId[];
  icon: IconName;
  /** True only when the person's own plan allowance is used up (show the upgrade prompt). */
  isPlanLimit: boolean;
  quota?: QuotaStatus | undefined;
}

export interface ImportOutcomeContext {
  kind: ImportKind;
  plan: WebBillingTier;
}

const IMPORTS_ONLY_COUNT_WHEN_THEY_WORK = "Imports only count when they work.";

const unique = (actions: ImportActionId[]): ImportActionId[] => [...new Set(actions)];

/** Alternatives that make sense for what was being imported. */
const alternativesFor = (kind: ImportKind): ImportActionId[] =>
  kind === "url"
    ? ["paste_text", "scan_photo", "another_link"]
    : kind === "text"
      ? ["edit_text", "scan_photo"]
      : ["change_photos", "paste_text"];

/** Puts the server's suggested recovery first, when it applies to this import. */
const withSuggestion = (
  recovery: Recovery | undefined,
  kind: ImportKind,
  actions: ImportActionId[]
): ImportActionId[] => {
  switch (recovery?.suggestedAction) {
    case "retry_primary":
    case "try_again_later":
      return unique(["retry", ...actions]);
    case "retry_fallback":
      return recovery.allowFallback && kind === "url"
        ? unique(["retry_ai", ...actions])
        : unique(actions);
    case "try_another_url": {
      // This link won't work again: drop retries, keep the ways to get the same recipe in.
      const withoutRetries = actions.filter(
        (action) => action !== "retry" && action !== "retry_ai"
      );
      return unique(kind === "url" ? [...withoutRetries, "another_link"] : withoutRetries);
    }
    default:
      return unique(actions);
  }
};

const quotaDetail = (quota: QuotaStatus | undefined): string | undefined => {
  if (!quota) {
    return undefined;
  }

  if (hasMonthlyQuotaFields(quota)) {
    return formatMonthlyQuotaCopy(quota, "");
  }

  return `${quota.remaining} of ${quota.limit} free imports left`;
};

const describePlanLimit = (
  failure: ExtractRecipeFailure,
  context: ImportOutcomeContext
): ImportProblem => {
  const quota = failure.quota;

  if (!quota) {
    // Billing could not be checked (a hiccup on our side), not an empty allowance.
    return {
      actions: ["retry"],
      icon: "clock",
      isPlanLimit: false,
      kind: "allowance_check",
      message:
        "We couldn't check how many imports you have left just now. Please try again in a moment.",
      title: "One moment"
    };
  }

  const monthly = hasMonthlyQuotaFields(quota);
  const free = context.plan === "free";

  return {
    actions: context.plan === "family" ? [] : ["see_plans"],
    detail: quotaDetail(quota),
    icon: "sparkles",
    isPlanLimit: true,
    kind: "plan_limit",
    message: free
      ? `Your first ${quota.limit} imports were on us. LinkDish Plus gives you 100 imports a month and room for every recipe you love.`
      : monthly
        ? "You've used this month's imports. They refill when the month turns over."
        : "You've used the imports on your plan.",
    quota,
    title: free && !monthly ? "You've used your free imports" : "That's this month's imports"
  };
};

/** A failure response from POST /extract, in words. */
export const describeImportFailure = (
  failure: ExtractRecipeFailure,
  context: ImportOutcomeContext
): ImportProblem => {
  const { kind } = context;
  const recovery = failure.recovery;
  const base = { isPlanLimit: false, quota: failure.quota };

  switch (failure.reason) {
    case "plan_limit":
      return describePlanLimit(failure, context);

    case "quota_exceeded":
      // The AI provider is out of capacity. Not the person's plan: never upsell here.
      return {
        ...base,
        actions: unique(["retry", ...(kind === "url" ? (["another_link"] as const) : [])]),
        icon: "hourglass",
        kind: "capacity",
        message:
          "Our AI recipe reader is swamped right now. This isn't your plan limit, and it didn't use an import. Try again in a few minutes.",
        title: "Our recipe helper needs a breather"
      };

    case "source_unreachable":
      return {
        ...base,
        actions: withSuggestion(recovery, kind, ["retry", "paste_text", "another_link"]),
        icon: "wifi-off",
        kind: "unreachable",
        message:
          "That site didn't answer. Check the link is right, or try again in a moment. If it keeps happening, paste the recipe text instead.",
        title: "We couldn't reach that page"
      };

    case "source_blocked":
      return {
        ...base,
        actions: withSuggestion(recovery, kind, ["paste_text", "scan_photo", "another_link"]),
        icon: "lock",
        kind: "blocked",
        message:
          "Some sites don't let recipe savers in. Copy the recipe from the page and paste it here, or snap a photo of it.",
        title: "That site kept its door shut"
      };

    case "timeout":
      return {
        ...base,
        actions: withSuggestion(recovery, kind, ["retry", ...alternativesFor(kind)]),
        icon: "clock",
        kind: "timeout",
        message: `That took longer than we could wait. Slow sites often work on a second try. ${IMPORTS_ONLY_COUNT_WHEN_THEY_WORK}`,
        title: "That page was slow to load"
      };

    case "unsupported_source":
      return {
        ...base,
        actions: withSuggestion(recovery, kind, alternativesFor(kind)),
        icon: "link",
        kind: "unsupported",
        message:
          "LinkDish can't read that kind of link yet. Paste the recipe text or scan a photo, and we'll tidy it up just the same.",
        title: "We can't open that link yet"
      };

    case "parse_failed":
      return {
        ...base,
        actions: withSuggestion(recovery, kind, [
          ...(kind === "url" && recovery?.allowFallback ? (["retry_ai"] as const) : []),
          ...alternativesFor(kind)
        ]),
        icon: "search-x",
        kind: "not_found",
        message:
          kind === "text"
            ? "We couldn't spot ingredients and steps in that text. Paste the whole recipe, from the ingredients to the last step."
            : kind === "images"
              ? "We couldn't read a recipe in those photos. Try a sharper, well-lit photo of the whole page."
              : "We looked, but couldn't find a recipe on that page. If it's there, paste the recipe text and we'll take it from there.",
        title:
          kind === "url"
            ? "No recipe on that page"
            : kind === "text"
              ? "No recipe in that text"
              : "No recipe in those photos"
      };

    case "fallback_unavailable":
      return {
        ...base,
        actions: unique(["retry", ...(kind === "url" ? (["another_link"] as const) : [])]),
        icon: "hourglass",
        kind: "ai_unavailable",
        message: `Our AI recipe reader is taking a break. ${IMPORTS_ONLY_COUNT_WHEN_THEY_WORK} Please try again a little later.`,
        title: "AI help is resting"
      };

    case "fallback_failed":
      return {
        ...base,
        actions: withSuggestion(recovery, kind, alternativesFor(kind)),
        icon: "search-x",
        kind: "ai_failed",
        message:
          kind === "url"
            ? "Even with AI help we couldn't pull a recipe from that link. Paste the recipe text or scan a photo instead."
            : "Even with AI help we couldn't read a recipe there. Give it another go with a little more of the recipe.",
        title: "That one got away"
      };

    default:
      // A reason this app doesn't know yet (a newer API): stay helpful and honest.
      return {
        ...base,
        actions: withSuggestion(recovery, kind, alternativesFor(kind)),
        icon: "search-x",
        kind: "not_found",
        message: `We couldn't get a recipe from that. ${IMPORTS_ONLY_COUNT_WHEN_THEY_WORK}`,
        title: "That didn't work this time"
      };
  }
};

/** Thrown request errors (network, timeout, HTTP, contract). Never an upsell. */
export const describeImportError = (
  error: unknown,
  context: ImportOutcomeContext
): ImportProblem => {
  const { kind } = context;
  const base = { isPlanLimit: false };

  if (isOffline()) {
    return {
      ...base,
      actions: ["retry"],
      icon: "wifi-off",
      kind: "offline",
      message: "Connect to the internet and try again. Your saved recipes are still here.",
      title: "You're offline"
    };
  }

  const apiKind = getApiErrorKind(error);
  const status = isExtractorApiError(error) ? error.statusCode : 0;
  const friendly = getFriendlyErrorMessage(error, "extract");

  if (apiKind === "network") {
    return {
      ...base,
      actions: ["retry"],
      icon: "wifi-off",
      kind: "network",
      message: friendly,
      title: "We couldn't reach LinkDish"
    };
  }

  if (apiKind === "timeout" || status === 408) {
    return {
      ...base,
      actions: ["retry", ...alternativesFor(kind).slice(0, 1)],
      icon: "clock",
      kind: "timeout",
      message: `That took too long to answer. ${IMPORTS_ONLY_COUNT_WHEN_THEY_WORK} Give it another try.`,
      title: "That was slow"
    };
  }

  if (status === 429) {
    return {
      ...base,
      actions: ["retry"],
      icon: "hourglass",
      kind: "rate_limited",
      message: "That's a lot of imports in a short time. Take a breath and try again in a minute.",
      title: "Slow down, chef"
    };
  }

  if (status === 413) {
    return {
      ...base,
      actions: kind === "images" ? ["change_photos"] : kind === "text" ? ["edit_text"] : ["retry"],
      icon: "alert-circle",
      kind: "too_large",
      message:
        kind === "images"
          ? "Those photos are too big to send. Try fewer photos, or crop to just the recipe."
          : "That's too much to import in one go. Trim it down to just the recipe.",
      title: "That's a big one"
    };
  }

  if (status === 400 || apiKind === "validation") {
    return {
      ...base,
      actions: kind === "url" ? ["another_link", "paste_text"] : alternativesFor(kind),
      icon: "alert-circle",
      kind: "invalid",
      message:
        kind === "url"
          ? "That link doesn't look like a web page we can open. Check it and try again."
          : (getServerErrorMessage(error) ?? friendly),
      title: kind === "url" ? "That link didn't work" : "That didn't go through"
    };
  }

  return {
    ...base,
    actions: ["retry", ...alternativesFor(kind).slice(0, 1)],
    icon: "alert-triangle",
    kind: "server",
    message: `${friendly} ${IMPORTS_ONLY_COUNT_WHEN_THEY_WORK}`.trim(),
    title: "Something went wrong on our side"
  };
};

/** Analytics failure_reason / status_code for a thrown error (unchanged vocabulary). */
export const getImportErrorAnalytics = (
  error: unknown
): { failure_reason: "api_error" | "network_error"; status_code?: number } => {
  const apiKind = getApiErrorKind(error);
  const isApiResponseError =
    isExtractorApiError(error) && apiKind !== "network" && apiKind !== "timeout";

  return isApiResponseError
    ? { failure_reason: "api_error", status_code: error.statusCode }
    : { failure_reason: "network_error" };
};

export interface NeedsRetryCopy {
  title: string;
  message: string;
}

/** A needs_retry answer, explained without "confidence scores". */
export const describeNeedsRetry = (response: ExtractRecipeNeedsRetry): NeedsRetryCopy => {
  const missing = describeMissingFields(response.diagnostics.missingFields);

  switch (response.reason) {
    case "transcript_required":
      return {
        message:
          "The recipe lives in the video rather than on the page. LinkDish can listen in and write it down for you.",
        title: "This recipe is in the video"
      };
    case "unsupported_primary_extraction":
      return {
        message:
          response.sourceType === "social"
            ? "Recipes in captions and posts need a closer read. AI help can pull out the ingredients and steps."
            : "This page doesn't label its recipe the usual way. AI help can read it like a person would.",
        title:
          response.sourceType === "social"
            ? "This recipe is in a caption"
            : "This one needs a closer read"
      };
    case "missing_required_fields":
    case "low_confidence":
      return {
        message: missing
          ? `We couldn't find ${missing} on that page. AI help can read the whole page and fill in the gaps.`
          : "Some of it was hard to read. AI help can read the whole page and fill in the gaps.",
        title: "We found part of a recipe"
      };
  }
};

const MISSING_FIELD_LABELS: Record<string, string> = {
  cookTimeMinutes: "the cooking time",
  ingredients: "the ingredients",
  prepTimeMinutes: "the prep time",
  servings: "how many it serves",
  steps: "the steps"
};

const joinList = (items: string[]): string =>
  items.length <= 1
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1] ?? ""}`;

/** "the ingredients and the steps", or "" when nothing important is missing. */
export const describeMissingFields = (fields: readonly string[]): string =>
  joinList(
    fields
      .filter((field) => field === "ingredients" || field === "steps")
      .map((field) => MISSING_FIELD_LABELS[field] ?? field)
  );

/* ------------------------------------------------------------------------------------------------
 * Notes shown with a successful import
 * ---------------------------------------------------------------------------------------------- */

/** Extractor warnings written for developers; never shown to cooks. */
const DEVELOPER_WARNING_PATTERN =
  /json-?ld|microdata|schema|pattern matching|fallback|extraction|extractor|transcript-dependent|description-level|cues|provenance|confidence|heuristic|parser|dom\b|selector|llm|model/iu;

export interface ImportNotesInput {
  warnings: readonly string[];
  missingFields?: readonly string[] | undefined;
  confidenceScore?: number | undefined;
  strategy?: string | undefined;
  sourceKind?: "web" | "photos" | "text" | undefined;
}

/**
 * Gentle notes for the imported recipe ("Give the amounts a quick look"). Developer-flavoured
 * extractor warnings are translated or dropped; missing times and servings are named plainly.
 */
export const getFriendlyImportNotes = ({
  warnings,
  missingFields = [],
  confidenceScore,
  strategy,
  sourceKind = "web"
}: ImportNotesInput): string[] => {
  const notes: string[] = [];
  const readFromText =
    strategy === "article-pattern" ||
    strategy === "llm-fallback" ||
    strategy === "youtube-transcript" ||
    warnings.some((warning) => /pattern matching|inferred|visible/iu.test(warning));

  if (strategy === "youtube-transcript") {
    notes.push(
      "We wrote this down from the video, so check anything the cook only showed on screen."
    );
  } else if (sourceKind === "photos") {
    notes.push("We read this from your photos. Give the amounts a quick look before you cook.");
  } else if ((confidenceScore ?? 1) < 0.7 || readFromText) {
    notes.push(
      "We tidied this one up from the page text, so give the amounts a quick look before you cook."
    );
  }

  const minorMissing = missingFields
    .filter(
      (field) => field === "servings" || field === "prepTimeMinutes" || field === "cookTimeMinutes"
    )
    .map((field) => MISSING_FIELD_LABELS[field] ?? field);

  if (minorMissing.length > 0) {
    notes.push(`The page didn't mention ${joinList(minorMissing)}.`);
  }

  for (const warning of warnings) {
    const trimmed = warning.trim();

    if (
      trimmed.length >= 12 &&
      trimmed.length <= 220 &&
      !DEVELOPER_WARNING_PATTERN.test(trimmed) &&
      !notes.includes(trimmed)
    ) {
      notes.push(trimmed);
    }
  }

  return notes.slice(0, 4);
};
