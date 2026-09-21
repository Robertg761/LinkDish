export const toTrimmedOrNull = (value: string): string | null => {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const namedHtmlEntityMap: Record<string, string> = {
  amp: "&",
  apos: "'",
  frac14: "¼",
  frac12: "½",
  frac34: "¾",
  gt: ">",
  hellip: "…",
  lt: "<",
  mdash: "—",
  nbsp: " ",
  ndash: "–",
  quot: '"'
};

const FIRST_SURROGATE_CODE_POINT = 0xd800;
const LAST_SURROGATE_CODE_POINT = 0xdfff;
const MAX_UNICODE_CODE_POINT = 0x10ffff;

// Tab, line feed and carriage return are the only control characters that carry meaning in
// recipe text. Everything else in the C0/C1 ranges (plus DEL) is dropped so attacker-controlled
// page content cannot smuggle raw control bytes into stored recipes.
const allowedControlCodePoints = new Set([0x09, 0x0a, 0x0d]);

const isSurrogateCodePoint = (codePoint: number): boolean =>
  codePoint >= FIRST_SURROGATE_CODE_POINT && codePoint <= LAST_SURROGATE_CODE_POINT;

const isDisallowedControlCodePoint = (codePoint: number): boolean => {
  if (allowedControlCodePoints.has(codePoint)) {
    return false;
  }

  return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
};

export const decodeHtmlEntities = (value: string): string =>
  value.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]+);/giu, (entity, token: string) => {
    if (token.startsWith("#")) {
      const isHex = token[1]?.toLowerCase() === "x";
      const rawCodePoint = isHex ? token.slice(2) : token.slice(1);
      const codePoint = Number.parseInt(rawCodePoint, isHex ? 16 : 10);

      if (
        !Number.isFinite(codePoint) ||
        codePoint <= 0 ||
        codePoint > MAX_UNICODE_CODE_POINT ||
        isSurrogateCodePoint(codePoint) ||
        isDisallowedControlCodePoint(codePoint)
      ) {
        return entity;
      }

      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return entity;
      }
    }

    return namedHtmlEntityMap[token.toLowerCase()] ?? entity;
  });

export const assertNever = (value: never): never => {
  throw new Error(`Unhandled value: ${String(value)}`);
};

export const wait = async (milliseconds: number): Promise<void> => {
  await new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
};

export const v2AnalyticsEventNames = [
  "import_started",
  "import_succeeded",
  "import_failed",
  "import_needs_retry",
  "import_cancelled",
  "import_abandoned",
  "recipe_opened",
  "cook_mode_started",
  "cook_mode_completed",
  "recipe_saved",
  "family_shared",
  "upgrade_viewed",
  "upgrade_purchased",
  "shopping_item_added",
  "shopping_item_checked"
] as const;

export type V2AnalyticsEventName = (typeof v2AnalyticsEventNames)[number];

export type V2AnalyticsSourceType = "image" | "share_target" | "text" | "unknown" | "url";

export type V2AnalyticsImportAttempt = "fallback" | "primary";

export type V2AnalyticsImportProperties = {
  source_type: V2AnalyticsSourceType;
  source_host?: string;
  attempt?: V2AnalyticsImportAttempt;
};

export type V2AnalyticsEventPayloads = {
  import_started: V2AnalyticsImportProperties;
  import_succeeded: V2AnalyticsImportProperties & {
    fetch_mode?: string;
    provenance_count?: number;
    strategy?: string;
    warning_count?: number;
  };
  import_failed: V2AnalyticsImportProperties & {
    failure_reason?: string;
    status_code?: number;
  };
  import_needs_retry: V2AnalyticsImportProperties & {
    retry_reason?: string;
  };
  import_cancelled: V2AnalyticsImportProperties & {
    cancellation_reason?: string;
  };
  import_abandoned: V2AnalyticsImportProperties & {
    abandonment_reason?: string;
  };
  recipe_opened: {
    surface: "cookbook" | "import_result" | "recipe_detail" | "shared_link" | "unknown";
  };
  cook_mode_started: {
    entry_point: "recipe_detail" | "unknown";
    step_count?: number;
  };
  cook_mode_completed: {
    elapsed_seconds?: number;
    step_count?: number;
  };
  recipe_saved: {
    source_type: V2AnalyticsSourceType;
    surface: "import_result" | "recipe_detail" | "unknown";
  };
  family_shared: {
    recipe_count?: number;
    share_scope: "household" | "unknown";
  };
  upgrade_viewed: {
    trigger: "import_limit" | "household" | "onboarding" | "pricing" | "unknown";
  };
  upgrade_purchased: {
    billing_period?: "lifetime" | "monthly" | "yearly";
    plan: "family" | "plus" | "unknown";
    trigger?: "founding" | "import_limit" | "household" | "onboarding" | "pricing" | "unknown";
  };
  shopping_item_added: {
    source: "manual" | "recipe" | "unknown";
  };
  shopping_item_checked: {
    source: "manual" | "recipe" | "unknown";
  };
};

export type V2AnalyticsEvent<EventName extends V2AnalyticsEventName = V2AnalyticsEventName> = {
  [Name in EventName]: {
    name: Name;
    correlationId?: string;
    properties: V2AnalyticsEventPayloads[Name];
    routeOrScreen?: string;
  };
}[EventName];

export type V2AnalyticsEmitter = <EventName extends V2AnalyticsEventName>(
  event: V2AnalyticsEvent<EventName>
) => void;

export const noopV2AnalyticsEmitter: V2AnalyticsEmitter = () => undefined;
