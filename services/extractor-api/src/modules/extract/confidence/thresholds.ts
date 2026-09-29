/*
 * Minimum confidence for a deterministic result to be returned as a success
 * instead of needs_retry. The extraction result cache reuses the same bar:
 * only results at least this confident are shared between users.
 */
export const successConfidenceThresholds = {
  "recipe-webpage": 0.8,
  article: 0.84,
  youtube: 0.82
} as const;

export type ThresholdSourceType = keyof typeof successConfidenceThresholds;

export const isThresholdSourceType = (sourceType: string): sourceType is ThresholdSourceType =>
  sourceType in successConfidenceThresholds;
