import { createGeminiFallbackExtractor } from "./gemini-fallback-extractor.js";
import { createOpenAiFallbackExtractor } from "./openai-fallback-extractor.js";

import type { FallbackRecipeExtractor } from "../types.js";

export const createFallbackExtractor = (options: {
  provider: "gemini" | "openai" | "none";
  geminiApiKey: string | undefined;
  geminiModel: string | undefined;
  openAiApiKey: string | undefined;
  openAiModel: string | undefined;
  fetchImplementation: typeof fetch;
  timeoutMs: number;
}): FallbackRecipeExtractor => {
  if (options.provider === "gemini") {
    return createGeminiFallbackExtractor({
      apiKey: options.geminiApiKey,
      model: options.geminiModel,
      fetchImplementation: options.fetchImplementation,
      timeoutMs: options.timeoutMs
    });
  }

  if (options.provider === "openai") {
    return createOpenAiFallbackExtractor(options.openAiApiKey, options.openAiModel);
  }

  return createGeminiFallbackExtractor({
    apiKey: undefined,
    model: undefined,
    fetchImplementation: options.fetchImplementation,
    timeoutMs: options.timeoutMs
  });
};
