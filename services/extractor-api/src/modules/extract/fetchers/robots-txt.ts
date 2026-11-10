import { isSourceUrlRejection, validatePublicSourceUrl } from "../source-url-safety.js";

import {
  createTimeoutSignal,
  LINKDISH_BOT_TOKEN,
  LINKDISH_BOT_USER_AGENT,
  readLimitedResponseText
} from "./shared.js";

import type { ValidateSourceUrl } from "../source-url-safety.js";

/*
 * robots.txt, per RFC 9309 (the Robots Exclusion Protocol). LinkDish fetches a page only when a
 * person asks it to import that page, but it still identifies itself (LINKDISH_BOT_TOKEN in the
 * user-agent) and obeys each site's robots.txt for it, before every request to that site:
 *
 * - The group for "LinkDishBot" applies when the file has one, otherwise the "*" group.
 * - The longest matching Allow/Disallow rule wins; Allow wins a tie. "*" and "$" work as in the RFC.
 * - 2xx: the rules apply. 4xx (no file, or the file is refused): everything is allowed (RFC 2.3.1.3).
 * - 5xx, a network error or a timeout: the file is "unreachable" and everything is disallowed
 *   (RFC 2.3.1.4). Imports from that site fail until it answers again.
 * - At most 500 KiB is parsed and at most 5 redirects are followed (RFC 2.3.1.2, 2.5).
 * - Answers are cached per origin: 1 hour for a file or a 4xx, 5 minutes for "unreachable"
 *   (RFC 2.4 allows up to 24 hours).
 *
 * A disallowed page is never retried in the headless browser, never fetched another way, and the
 * import fails as "source_blocked".
 */

export { LINKDISH_BOT_TOKEN, LINKDISH_BOT_USER_AGENT };

const maxRobotsBytes = 500 * 1024;
const maxRobotsRedirects = 5;
const defaultRobotsTimeoutMs = 3_000;
const successTtlMs = 60 * 60 * 1000;
const unreachableTtlMs = 5 * 60 * 1000;
const maxCachedOrigins = 1_000;

interface RobotsRule {
  allow: boolean;
  pattern: string;
}

export type RobotsRules =
  { kind: "rules"; rules: RobotsRule[] } | { kind: "allow_all" } | { kind: "disallow_all" };

export class RobotsDisallowedError extends Error {
  public constructor(public readonly url: string) {
    super(`robots.txt does not allow LinkDish to fetch ${url}.`);
    this.name = "RobotsDisallowedError";
  }
}

export const isRobotsDisallowedError = (error: unknown): error is RobotsDisallowedError =>
  error instanceof RobotsDisallowedError;

/** The blocked-signal name a robots.txt refusal carries on HtmlFetchError and BrowserFetchError. */
export const ROBOTS_DISALLOWED_SIGNAL = "robots_txt_disallowed";

const userAgentLinePattern = /^user-agent$/iu;

/** Parses a robots.txt body into the rules that apply to `token` (RFC 9309 section 2.2). */
export const parseRobotsTxt = (body: string, token: string = LINKDISH_BOT_TOKEN): RobotsRules => {
  const wantedToken = token.toLowerCase();
  const groups: { agents: string[]; rules: RobotsRule[] }[] = [];
  let current: { agents: string[]; rules: RobotsRule[] } | null = null;
  let lastLineWasAgent = false;

  for (const rawLine of body.slice(0, maxRobotsBytes).split(/\r\n|\r|\n/u)) {
    const line = rawLine.replace(/#.*$/u, "").trim();
    const separator = line.indexOf(":");

    if (separator === -1) {
      continue;
    }

    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();

    if (userAgentLinePattern.test(key)) {
      if (!current || !lastLineWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }

      // A product token is the name before any "/version" (RFC 9309 section 2.2.1).
      current.agents.push((value.split("/")[0] ?? "").trim().toLowerCase());
      lastLineWasAgent = true;
      continue;
    }

    lastLineWasAgent = false;
    const lowerKey = key.toLowerCase();

    if (!current || (lowerKey !== "allow" && lowerKey !== "disallow")) {
      continue;
    }

    // "Disallow:" with no path disallows nothing; it is not a rule.
    if (value === "") {
      continue;
    }

    current.rules.push({ allow: lowerKey === "allow", pattern: value });
  }

  const matching = groups.filter((group) => group.agents.includes(wantedToken));
  const applicable =
    matching.length > 0 ? matching : groups.filter((group) => group.agents.includes("*"));

  return { kind: "rules", rules: applicable.flatMap((group) => group.rules) };
};

/* Percent-encodes what needs it and decodes what doesn't, so "/caf%C3%A9" and "/café" compare equal. */
const normalizePath = (value: string): string => {
  try {
    return encodeURI(decodeURI(value));
  } catch {
    return value;
  }
};

const escapeRegExp = (value: string): string => value.replace(/[.+?^{}()|[\]\\]/gu, "\\$&");

const ruleMatches = (pattern: string, path: string): boolean => {
  const anchored = pattern.endsWith("$");
  const body = normalizePath(anchored ? pattern.slice(0, -1) : pattern);
  // Linear-time enough for robots patterns: "*" becomes a lazy wildcard, nothing else is special.
  const expression = new RegExp(
    `^${body.split("*").map(escapeRegExp).join(".*?")}${anchored ? "$" : ""}`,
    "u"
  );

  return expression.test(path);
};

/** Whether `url` may be fetched under `rules` (RFC 9309 section 2.2.2). */
export const isAllowedByRobots = (rules: RobotsRules, url: string): boolean => {
  if (rules.kind === "allow_all") {
    return true;
  }

  if (rules.kind === "disallow_all") {
    return false;
  }

  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  const path = normalizePath(`${parsed.pathname || "/"}${parsed.search}`);

  // The robots.txt file itself is always allowed (RFC 9309 section 2.2.2).
  if (parsed.pathname === "/robots.txt") {
    return true;
  }

  let best: RobotsRule | null = null;

  for (const rule of rules.rules) {
    if (!ruleMatches(rule.pattern, path)) {
      continue;
    }

    if (
      !best ||
      rule.pattern.length > best.pattern.length ||
      (rule.pattern.length === best.pattern.length && rule.allow && !best.allow)
    ) {
      best = rule;
    }
  }

  return best ? best.allow : true;
};

export interface RobotsTxtPolicy {
  /** Whether LinkDish may fetch `url`. Fetches (and caches) the origin's robots.txt when needed. */
  isAllowed(url: string, options?: { signal?: AbortSignal | undefined }): Promise<boolean>;
  /** Throws RobotsDisallowedError when `url` may not be fetched. */
  assertAllowed(url: string, options?: { signal?: AbortSignal | undefined }): Promise<void>;
  readonly enforced: boolean;
}

export interface CreateRobotsTxtPolicyOptions {
  enabled: boolean;
  fetchImplementation: typeof fetch;
  validateUrl?: ValidateSourceUrl;
  timeoutMs?: number;
  now?: () => number;
  userAgent?: string;
}

const readRobots = async (
  origin: string,
  options: Required<Pick<CreateRobotsTxtPolicyOptions, "fetchImplementation" | "userAgent">> & {
    validateUrl: ValidateSourceUrl;
    timeoutMs: number;
    signal?: AbortSignal | undefined;
  }
): Promise<{ rules: RobotsRules; ttlMs: number }> => {
  const unreachable = { rules: { kind: "disallow_all" } as const, ttlMs: unreachableTtlMs };
  const timeout = createTimeoutSignal(options.timeoutMs, options.signal);
  let requestUrl = `${origin}/robots.txt`;

  try {
    for (let hop = 0; hop <= maxRobotsRedirects; hop += 1) {
      const safety = await options.validateUrl(requestUrl);

      if (isSourceUrlRejection(safety)) {
        return unreachable;
      }

      const response = await options.fetchImplementation(requestUrl, {
        headers: { accept: "text/plain,*/*;q=0.5", "user-agent": options.userAgent },
        redirect: "manual",
        signal: timeout.signal
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");

        if (!location || hop === maxRobotsRedirects) {
          // RFC 9309 2.3.1.2: past five redirects the file MAY be treated as unavailable.
          return { rules: { kind: "allow_all" }, ttlMs: successTtlMs };
        }

        requestUrl = new URL(location, requestUrl).toString();
        continue;
      }

      if (response.status >= 200 && response.status < 300) {
        const body = await readLimitedResponseText(response, maxRobotsBytes).catch(() => null);

        return body === null ? unreachable : { rules: parseRobotsTxt(body), ttlMs: successTtlMs };
      }

      if (response.status >= 400 && response.status < 500) {
        return { rules: { kind: "allow_all" }, ttlMs: successTtlMs };
      }

      return unreachable;
    }

    return unreachable;
  } catch (error) {
    // The caller's own cancellation is not the site's fault: rethrow it, cache nothing.
    if (options.signal?.aborted && !timeout.timedOut()) {
      throw error;
    }

    return unreachable;
  } finally {
    timeout.cleanup();
  }
};

export const createRobotsTxtPolicy = (options: CreateRobotsTxtPolicyOptions): RobotsTxtPolicy => {
  const cache = new Map<string, { rules: RobotsRules; expiresAt: number }>();
  const inFlight = new Map<string, Promise<RobotsRules>>();
  const now = options.now ?? Date.now;
  const validateUrl = options.validateUrl ?? validatePublicSourceUrl;
  const timeoutMs = options.timeoutMs ?? defaultRobotsTimeoutMs;
  const userAgent = options.userAgent ?? LINKDISH_BOT_USER_AGENT;

  const rulesFor = async (origin: string, signal?: AbortSignal): Promise<RobotsRules> => {
    const cached = cache.get(origin);

    if (cached && cached.expiresAt > now()) {
      return cached.rules;
    }

    const pending = inFlight.get(origin);

    if (pending) {
      return pending;
    }

    const lookup = readRobots(origin, {
      fetchImplementation: options.fetchImplementation,
      timeoutMs,
      userAgent,
      validateUrl,
      ...(signal ? { signal } : {})
    })
      .then(({ rules, ttlMs }) => {
        if (cache.size >= maxCachedOrigins) {
          const oldest = cache.keys().next().value;

          if (oldest !== undefined) {
            cache.delete(oldest);
          }
        }

        cache.set(origin, { expiresAt: now() + ttlMs, rules });
        return rules;
      })
      .finally(() => {
        inFlight.delete(origin);
      });

    inFlight.set(origin, lookup);
    return lookup;
  };

  const isAllowed: RobotsTxtPolicy["isAllowed"] = async (url, callOptions) => {
    if (!options.enabled) {
      return true;
    }

    let parsed: URL;

    try {
      parsed = new URL(url);
    } catch {
      return false;
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }

    const rules = await rulesFor(parsed.origin, callOptions?.signal);
    return isAllowedByRobots(rules, parsed.toString());
  };

  return {
    enforced: options.enabled,
    isAllowed,
    assertAllowed: async (url, callOptions) => {
      if (!(await isAllowed(url, callOptions))) {
        throw new RobotsDisallowedError(url);
      }
    }
  };
};

/**
 * A fetch that checks robots.txt before every request it makes, redirect hops included (callers
 * follow redirects by hand). A disallowed URL throws RobotsDisallowedError without any request to
 * it. Only for requests to the sites people import from, never for API calls such as Gemini.
 */
export const createRobotsAwareFetch =
  (fetchImplementation: typeof fetch, policy: RobotsTxtPolicy): typeof fetch =>
  async (input, init) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    await policy.assertAllowed(url, { signal: init?.signal ?? undefined });
    return fetchImplementation(input, init);
  };
