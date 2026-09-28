/* Time kept back for normalising and returning the response after the model answers. */
export const fallbackResponseReserveMs = 1_500;

/* A second Gemini attempt (after an empty or invalid answer) only runs with at least this much time left. */
export const minimumRetryBudgetMs = 8_000;
