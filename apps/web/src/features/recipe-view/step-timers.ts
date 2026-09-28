import { formatDuration } from "@linkdish/recipe-domain";

import type { ParsedStepDuration } from "@linkdish/recipe-domain";

/** Timer length for a step duration: the low end of a range, so you check early. */
export const getStepTimerSeconds = (duration: ParsedStepDuration): number =>
  Math.max(1, duration.minSeconds || duration.maxSeconds);

const formatSeconds = (seconds: number): string => {
  if (seconds < 60) {
    return `${seconds} sec`;
  }

  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${formatDuration(minutes)} ${rest} sec` : formatDuration(minutes);
};

/**
 * Short chip label for a step duration: "25 min", "30–35 min", "1–2 hr", "1 hr 30 min". The
 * step text keeps the wording ("an additional 25 minutes"); the chip only needs the time.
 */
export const formatStepTimerLabel = (duration: ParsedStepDuration): string => {
  const { minSeconds, maxSeconds } = duration;

  if (!minSeconds || minSeconds === maxSeconds) {
    return formatSeconds(maxSeconds || minSeconds);
  }

  const bothMinutes = minSeconds % 60 === 0 && maxSeconds % 60 === 0 && maxSeconds < 3600;
  const bothHours = minSeconds % 3600 === 0 && maxSeconds % 3600 === 0;

  if (bothMinutes) {
    return `${minSeconds / 60}–${maxSeconds / 60} min`;
  }

  if (bothHours) {
    return `${minSeconds / 3600}–${maxSeconds / 3600} hr`;
  }

  return `${formatSeconds(minSeconds)}–${formatSeconds(maxSeconds)}`;
};
