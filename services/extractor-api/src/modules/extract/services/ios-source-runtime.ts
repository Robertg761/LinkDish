import { isSupportedIosRecipeUrl } from "../../../../../../packages/recipe-domain/src/index.js";
import { extractorApiEnv } from "../../../config/env.js";
import { HtmlFetchError } from "../fetchers/errors.js";
import { fetchHtmlDocument } from "../fetchers/fetch-html-document.js";
import { publicOnlyFetch } from "../fetchers/public-fetch.js";
import { identifyingFetchHeaders, readLimitedResponseText } from "../fetchers/shared.js";
import { validatePublicSourceUrl } from "../source-url-safety.js";

import type { ValidateSourceUrl } from "../source-url-safety.js";
import type { ExtractorRuntime } from "../types.js";

const blocked = () =>
  new HtmlFetchError("This source is outside the iPhone import policy.", "blocked", [
    "ios_source_policy"
  ]);

/** A request-scoped runtime: never mutates the shared runtime used by Android/web. */
export const createIosSourceRuntime = (
  base: ExtractorRuntime,
  transport: typeof fetch = publicOnlyFetch,
  validatePublicUrl: ValidateSourceUrl = validatePublicSourceUrl
): ExtractorRuntime => {
  const validateUrl: ValidateSourceUrl = (url) =>
    isSupportedIosRecipeUrl(url)
      ? validatePublicUrl(url)
      : Promise.resolve({ safe: false, reason: "blocked_hostname" });
  const rejectFetch = () => Promise.reject(blocked());
  let robotsPermission: Promise<void> | undefined;

  return {
    // Deliberately enumerate capabilities: browser, social/video fetchers and the shared
    // result/fallback cache must not re-enter through a spread of the unrestricted runtime.
    fetchImplementation: rejectFetch,
    fetchYouTubeDocument: rejectFetch,
    validateSourceUrl: validateUrl,
    fallbackExtractor: base.fallbackExtractor,
    ...(base.recipeTextCleaner ? { recipeTextCleaner: base.recipeTextCleaner } : {}),
    dispose: () => Promise.resolve(),
    fetchHtmlDocument: async (url, options) => {
      if (!isSupportedIosRecipeUrl(url)) throw blocked();
      const timeoutMs =
        options?.deadline?.budgetMs(extractorApiEnv.FETCH_HTTP_TIMEOUT_MS) ??
        extractorApiEnv.FETCH_HTTP_TIMEOUT_MS;
      const signal = options?.deadline?.signal;
      robotsPermission ??= (async () => {
        const robotsUrl = "https://publicdomainrecipes.com/robots.txt";
        if (!(await validatePublicUrl(robotsUrl)).safe) throw blocked();
        const response = await transport(robotsUrl, {
          redirect: "manual",
          headers: identifyingFetchHeaders,
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
            : AbortSignal.timeout(timeoutMs)
        });
        if (response.status !== 200) throw blocked();
        const rules = (await readLimitedResponseText(response, 32_768))
          .split(/\r?\n/u)
          .map((line) => line.split("#")[0]!.trim());
        // Conservative for this single reviewed publisher: accept its observed open robots
        // policy only. Any nonempty Disallow (even for another bot) needs a fresh review.
        if (
          !rules.some((line) => /^user-agent\s*:\s*\*$/iu.test(line)) ||
          rules.some((line) => /^disallow\s*:\s*\S/iu.test(line))
        )
          throw blocked();
      })();
      await robotsPermission;
      return fetchHtmlDocument(url, transport, {
        timeoutMs,
        retries: 0,
        identifyingOnly: true,
        validateUrl,
        ...(signal ? { signal } : {})
      });
    }
  };
};
