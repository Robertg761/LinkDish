export const toTrimmedOrNull = (value: string): string | null => {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

/**
 * Named entities recipe pages actually use. JSON-LD and og:description text regularly carries
 * typographic quotes, degree signs, accented dish names and vulgar fractions as named entities
 * ("350&deg;F", "Grandma&rsquo;s", "Saut&eacute;ed", "jalape&ntilde;o", "2 &times; 400g"), so the
 * table covers punctuation, Latin-1 letters and every HTML5 fraction entity. Lookups are
 * case-sensitive first (`&Eacute;` vs `&eacute;`) and fall back to lowercase for legacy
 * uppercase spellings such as `&AMP;`.
 */
const namedHtmlEntityMap: Readonly<Record<string, string>> = {
  // Markup and whitespace
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  quot: '"',
  nbsp: " ",
  ensp: " ",
  emsp: " ",
  thinsp: " ",
  shy: "",
  zwj: "\u200d",
  zwnj: "\u200c",
  // Punctuation
  hellip: "…",
  mdash: "—",
  ndash: "–",
  minus: "−",
  lsquo: "‘",
  rsquo: "’",
  sbquo: "‚",
  ldquo: "“",
  rdquo: "”",
  bdquo: "„",
  laquo: "«",
  raquo: "»",
  lsaquo: "‹",
  rsaquo: "›",
  prime: "′",
  Prime: "″",
  bull: "•",
  middot: "·",
  iexcl: "¡",
  iquest: "¿",
  sect: "§",
  para: "¶",
  dagger: "†",
  Dagger: "‡",
  // Symbols
  deg: "°",
  times: "×",
  divide: "÷",
  plusmn: "±",
  frasl: "⁄",
  micro: "µ",
  copy: "©",
  reg: "®",
  trade: "™",
  cent: "¢",
  pound: "£",
  euro: "€",
  yen: "¥",
  ordm: "º",
  ordf: "ª",
  sup1: "¹",
  sup2: "²",
  sup3: "³",
  // Vulgar fractions (HTML5)
  frac12: "½",
  frac13: "⅓",
  frac14: "¼",
  frac15: "⅕",
  frac16: "⅙",
  frac18: "⅛",
  frac23: "⅔",
  frac25: "⅖",
  frac34: "¾",
  frac35: "⅗",
  frac38: "⅜",
  frac45: "⅘",
  frac56: "⅚",
  frac58: "⅝",
  frac78: "⅞",
  // Latin-1 letters used in dish and ingredient names
  aacute: "á",
  Aacute: "Á",
  agrave: "à",
  Agrave: "À",
  acirc: "â",
  Acirc: "Â",
  atilde: "ã",
  Atilde: "Ã",
  auml: "ä",
  Auml: "Ä",
  aring: "å",
  Aring: "Å",
  aelig: "æ",
  AElig: "Æ",
  ccedil: "ç",
  Ccedil: "Ç",
  eacute: "é",
  Eacute: "É",
  egrave: "è",
  Egrave: "È",
  ecirc: "ê",
  Ecirc: "Ê",
  euml: "ë",
  Euml: "Ë",
  iacute: "í",
  Iacute: "Í",
  igrave: "ì",
  Igrave: "Ì",
  icirc: "î",
  Icirc: "Î",
  iuml: "ï",
  Iuml: "Ï",
  ntilde: "ñ",
  Ntilde: "Ñ",
  oacute: "ó",
  Oacute: "Ó",
  ograve: "ò",
  Ograve: "Ò",
  ocirc: "ô",
  Ocirc: "Ô",
  otilde: "õ",
  Otilde: "Õ",
  ouml: "ö",
  Ouml: "Ö",
  oslash: "ø",
  Oslash: "Ø",
  oelig: "œ",
  OElig: "Œ",
  scaron: "š",
  Scaron: "Š",
  szlig: "ß",
  uacute: "ú",
  Uacute: "Ú",
  ugrave: "ù",
  Ugrave: "Ù",
  ucirc: "û",
  Ucirc: "Û",
  uuml: "ü",
  Uuml: "Ü",
  yacute: "ý",
  Yacute: "Ý",
  yuml: "ÿ",
  Yuml: "Ÿ"
};

/**
 * HTML5 decodes numeric references in the C1 range (0x80–0x9F) as Windows-1252, because
 * legacy CMS output is full of `&#146;` (’) and `&#150;` (–). Slots that Windows-1252 leaves
 * undefined (0x81, 0x8D, 0x8F, 0x90, 0x9D) stay undecoded like any other control character.
 */
const windows1252CodePoints: Readonly<Record<number, number>> = {
  0x80: 0x20ac,
  0x82: 0x201a,
  0x83: 0x0192,
  0x84: 0x201e,
  0x85: 0x2026,
  0x86: 0x2020,
  0x87: 0x2021,
  0x88: 0x02c6,
  0x89: 0x2030,
  0x8a: 0x0160,
  0x8b: 0x2039,
  0x8c: 0x0152,
  0x8e: 0x017d,
  0x91: 0x2018,
  0x92: 0x2019,
  0x93: 0x201c,
  0x94: 0x201d,
  0x95: 0x2022,
  0x96: 0x2013,
  0x97: 0x2014,
  0x98: 0x02dc,
  0x99: 0x2122,
  0x9a: 0x0161,
  0x9b: 0x203a,
  0x9c: 0x0153,
  0x9e: 0x017e,
  0x9f: 0x0178
};

const HTML_ENTITY_PATTERN = /&(#x?[0-9a-f]+|[a-z][a-z0-9]+);/giu;

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
  value.replace(HTML_ENTITY_PATTERN, (entity, token: string) => {
    if (token.startsWith("#")) {
      const isHex = token[1]?.toLowerCase() === "x";
      const rawCodePoint = isHex ? token.slice(2) : token.slice(1);
      const parsedCodePoint = Number.parseInt(rawCodePoint, isHex ? 16 : 10);
      const codePoint = windows1252CodePoints[parsedCodePoint] ?? parsedCodePoint;

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

    return namedHtmlEntityMap[token] ?? namedHtmlEntityMap[token.toLowerCase()] ?? entity;
  });

/** A "<" that HTML reads as the start of markup: one before a letter, "/", "!" or "?". */
const TAG_OPENER_PATTERN = /<(?=[!/?A-Za-z])/gu;

/**
 * Puts a space after every "<" that would still open markup once a tag stripper has run: one
 * followed by an ASCII letter, "/", "!" or "?", which HTML's tokenizer reads as the start of a
 * tag, an end tag, a comment or a declaration. However the input nested or split its tags
 * ("<scr<b>ipt>", an unclosed "<script"), the result never contains "<script", "</p" or "<!--",
 * and no character is lost: a real less-than keeps its meaning ("Heat to <medium" reads
 * "Heat to < medium", "<jane@example.com>" reads "< jane@example.com>"), and text such as
 * "cook to < 165°F", "<3" or "<- stir" is left as it is.
 */
export const defuseTagOpeners = (value: string): string => value.replace(TAG_OPENER_PATTERN, "< ");

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

export { getTokenSessionId } from "./token-session.js";
