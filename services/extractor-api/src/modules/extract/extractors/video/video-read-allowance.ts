import { runStoreTransaction } from "../../../storage/upstash-store.js";

/*
 * Every video read is a paid Gemini call, and links are metered as plain imports and TikTok
 * results are never cached, so nothing else bounds what the reader can spend. This caps the
 * Gemini calls per UTC day: across all instances with Upstash (one counter), per instance
 * without it. A call is counted before it is made, so the cap is never exceeded; calls that fail
 * still count.
 */

export interface VideoReadAllowance {
  /** Takes one of today's reads. False when today's reads are used up. Throws when unsure. */
  reserve(): Promise<boolean>;
}

const keyPrefix = "linkdish:video-reader:reads:v1";
/* Each day's counter outlives its day, so a read just before midnight is still counted. */
const counterTtlSeconds = 2 * 24 * 60 * 60;
/* A slow store must not eat the time the read itself needs. */
const storeTimeoutMs = 1_500;

export const getVideoReadCounterKey = (now: Date): string =>
  `${keyPrefix}:${now.toISOString().slice(0, 10)}`;

export const createDailyVideoReadAllowance = ({
  dailyLimit,
  now = () => new Date(),
  runTransaction = runStoreTransaction
}: {
  dailyLimit: number;
  now?: () => Date;
  runTransaction?: typeof runStoreTransaction;
}): VideoReadAllowance => ({
  reserve: async () => {
    if (dailyLimit <= 0) {
      return false;
    }

    const key = getVideoReadCounterKey(now());
    const [incremented] = await runTransaction(
      [
        ["INCR", key],
        ["EXPIRE", key, String(counterTtlSeconds), "NX"]
      ],
      { timeoutMs: storeTimeoutMs }
    );
    const count = Number(incremented?.result);

    if (incremented?.error || !Number.isFinite(count)) {
      throw new Error(incremented?.error ?? "The video read counter returned no count.");
    }

    return count <= dailyLimit;
  }
});
