import type * as FallbackInputBuilder from "./build-fallback-input.js";

/*
 * The prompt builder parses HTML (cheerio), which the fallback providers only
 * need once an LLM call is actually made, so it is loaded on first use rather
 * than with the admin model-control module on every cold start.
 */
let fallbackInputBuilder: Promise<typeof FallbackInputBuilder> | null = null;

export const loadFallbackInputBuilder = () => {
  fallbackInputBuilder ??= import("./build-fallback-input.js");
  return fallbackInputBuilder;
};
