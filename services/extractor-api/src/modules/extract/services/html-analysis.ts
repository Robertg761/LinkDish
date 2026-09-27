/*
 * Document-aware steps that need the HTML parser. The orchestrator imports
 * this module lazily, once an HTML page has actually been fetched.
 */
export { looksLikeNotFoundHtml } from "../html/page-signals.js";
export { detectSourceType } from "../source-detection/detect-source-type.js";
