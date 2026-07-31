import { extractorApiEnv } from "../../config/env.js";

interface UpstashResponse {
  error?: string;
  result?: unknown;
}

interface MemoryValue {
  expiresAtMs: number | null;
  value: string;
}

interface SetOptions {
  nx?: boolean;
  ttlSeconds?: number;
}

interface SortedSetMemberScore {
  member: string;
  score: number;
}

interface SlidingWindowRateLimitOptions {
  key: string;
  max: number;
  member: string;
  nowMs: number;
  ttlSeconds: number;
  windowMs: number;
}

interface SlidingWindowRateLimitResult {
  allowed: boolean;
  count: number;
}

const memoryValues = new Map<string, MemoryValue>();
const memorySets = new Map<string, Set<string>>();
const memorySortedSets = new Map<string, Map<string, number>>();
const memoryKeyExpirations = new Map<string, number>();

export class KeyValueStoreUnavailableError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "KeyValueStoreUnavailableError";
  }
}

export const isKeyValueStoreConfigured = (): boolean =>
  Boolean(extractorApiEnv.UPSTASH_REDIS_REST_URL && extractorApiEnv.UPSTASH_REDIS_REST_TOKEN);

const getUpstashUrl = (path: string): string => {
  if (!extractorApiEnv.UPSTASH_REDIS_REST_URL || !extractorApiEnv.UPSTASH_REDIS_REST_TOKEN) {
    throw new KeyValueStoreUnavailableError("Upstash Redis REST is not configured.");
  }

  return `${extractorApiEnv.UPSTASH_REDIS_REST_URL}${path}`;
};

const getHeaders = (): Record<string, string> => ({
  authorization: `Bearer ${extractorApiEnv.UPSTASH_REDIS_REST_TOKEN}`,
  "content-type": "application/json"
});

const pruneExpiredMemoryKey = (key: string): void => {
  const expiresAtMs = memoryKeyExpirations.get(key);

  if (expiresAtMs != null && expiresAtMs <= Date.now()) {
    memoryValues.delete(key);
    memorySets.delete(key);
    memorySortedSets.delete(key);
    memoryKeyExpirations.delete(key);
    return;
  }

  const entry = memoryValues.get(key);

  if (entry?.expiresAtMs != null && entry.expiresAtMs <= Date.now()) {
    memoryValues.delete(key);
  }
};

const parseNumeric = (value: unknown): number => {
  const numeric = typeof value === "string" ? Number(value) : value;
  return typeof numeric === "number" && Number.isFinite(numeric) ? numeric : 0;
};

const keyExists = (key: string): boolean =>
  memoryValues.has(key) || memorySets.has(key) || memorySortedSets.has(key);

const isUnknownArray = (value: unknown): value is unknown[] => Array.isArray(value);

const runMemoryCommand = (command: string[]): UpstashResponse => {
  const [rawName, key, ...args] = command;
  const name = rawName?.toUpperCase();

  if (!name) {
    return { error: "Missing command name." };
  }

  if (key) {
    pruneExpiredMemoryKey(key);
  }

  switch (name) {
    case "GET":
      return { result: key ? (memoryValues.get(key)?.value ?? null) : null };
    case "INCR": {
      if (!key) {
        return { error: "INCR requires a key." };
      }

      const existingEntry = memoryValues.get(key);
      const count = parseNumeric(existingEntry?.value) + 1;
      memoryValues.set(key, {
        expiresAtMs: existingEntry?.expiresAtMs ?? null,
        value: String(count)
      });

      return { result: count };
    }
    case "SET": {
      if (!key) {
        return { error: "SET requires a key." };
      }

      const value = args[0] ?? "";
      const normalizedArgs = args.slice(1).map((entry) => entry.toUpperCase());
      const nx = normalizedArgs.includes("NX");
      const exIndex = normalizedArgs.indexOf("EX");
      const ttlSeconds = exIndex >= 0 ? Number(args.slice(1)[exIndex + 1]) : null;

      if (nx && memoryValues.has(key)) {
        return { result: null };
      }

      memoryValues.set(key, {
        expiresAtMs:
          ttlSeconds && Number.isFinite(ttlSeconds) ? Date.now() + ttlSeconds * 1000 : null,
        value
      });

      return { result: "OK" };
    }
    case "DEL": {
      let count = 0;

      for (const deleteKey of [key, ...args].filter(
        (candidate): candidate is string => typeof candidate === "string" && candidate.length > 0
      )) {
        count += memoryValues.delete(deleteKey) ? 1 : 0;
        count += memorySets.delete(deleteKey) ? 1 : 0;
        count += memorySortedSets.delete(deleteKey) ? 1 : 0;
        memoryKeyExpirations.delete(deleteKey);
      }

      return { result: count };
    }
    case "EXPIRE": {
      if (!key) {
        return { error: "EXPIRE requires a key." };
      }

      if (!keyExists(key)) {
        return { result: 0 };
      }

      const ttlSeconds = Number(args[0]);
      const nx = args
        .slice(1)
        .map((entry) => entry.toUpperCase())
        .includes("NX");
      const entry = memoryValues.get(key);

      if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0 || !entry) {
        return { result: 0 };
      }

      if (nx && entry.expiresAtMs !== null) {
        return { result: 0 };
      }

      memoryValues.set(key, {
        ...entry,
        expiresAtMs: Date.now() + ttlSeconds * 1000
      });

      return { result: 1 };
    }
    case "TTL": {
      if (!key || !keyExists(key)) {
        return { result: -2 };
      }

      const entry = memoryValues.get(key);

      if (!entry || entry.expiresAtMs === null) {
        return { result: -1 };
      }

      return { result: Math.max(0, Math.ceil((entry.expiresAtMs - Date.now()) / 1000)) };
    }
    case "SADD": {
      if (!key) {
        return { error: "SADD requires a key." };
      }

      const set = memorySets.get(key) ?? new Set<string>();
      let added = 0;

      for (const value of args) {
        if (!set.has(value)) {
          added += 1;
          set.add(value);
        }
      }

      memorySets.set(key, set);
      return { result: added };
    }
    case "SREM": {
      const set = key ? memorySets.get(key) : null;
      let removed = 0;

      for (const value of args) {
        removed += set?.delete(value) ? 1 : 0;
      }

      return { result: removed };
    }
    case "SMEMBERS":
      return { result: key ? [...(memorySets.get(key) ?? [])] : [] };
    case "ZADD": {
      if (!key) {
        return { error: "ZADD requires a key." };
      }

      const sortedSet = memorySortedSets.get(key) ?? new Map<string, number>();
      let added = 0;

      for (let index = 0; index < args.length; index += 2) {
        const score = Number(args[index]);
        const member = args[index + 1];

        if (!Number.isFinite(score) || !member) {
          continue;
        }

        added += sortedSet.has(member) ? 0 : 1;
        sortedSet.set(member, score);
      }

      memorySortedSets.set(key, sortedSet);
      return { result: added };
    }
    case "ZREMRANGEBYSCORE": {
      const sortedSet = key ? memorySortedSets.get(key) : null;
      const min = Number(args[0]);
      const max = Number(args[1]);
      let removed = 0;

      if (sortedSet && Number.isFinite(min) && Number.isFinite(max)) {
        for (const [member, score] of sortedSet.entries()) {
          if (score >= min && score <= max) {
            sortedSet.delete(member);
            removed += 1;
          }
        }
      }

      return { result: removed };
    }
    case "ZCARD":
      return { result: key ? (memorySortedSets.get(key)?.size ?? 0) : 0 };
    case "ZRANGE":
    case "ZREVRANGE": {
      const sortedSet = key ? memorySortedSets.get(key) : null;
      const start = Number(args[0]);
      const stop = Number(args[1]);
      const withScores = args.some((arg) => arg.toUpperCase() === "WITHSCORES");

      if (!sortedSet || !Number.isInteger(start) || !Number.isInteger(stop) || start < 0) {
        return { result: [] };
      }

      const entries = [...sortedSet.entries()].sort((left, right) => {
        const scoreDelta = left[1] - right[1];
        return name === "ZREVRANGE"
          ? scoreDelta === 0
            ? right[0].localeCompare(left[0])
            : -scoreDelta
          : scoreDelta === 0
            ? left[0].localeCompare(right[0])
            : scoreDelta;
      });
      const selected = entries.slice(start, stop < 0 ? undefined : stop + 1);

      return {
        result: withScores
          ? selected.flatMap(([member, score]) => [member, String(score)])
          : selected.map(([member]) => member)
      };
    }
    default:
      return { error: `Unsupported in-memory command ${name}.` };
  }
};

export const runStoreTransaction = async (commands: string[][]): Promise<UpstashResponse[]> => {
  if (!isKeyValueStoreConfigured()) {
    return commands.map(runMemoryCommand);
  }

  const response = await fetch(getUpstashUrl("/multi-exec"), {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify(commands)
  });

  if (!response.ok) {
    throw new KeyValueStoreUnavailableError(`Upstash transaction failed with ${response.status}.`);
  }

  const body = (await response.json()) as UpstashResponse[] | UpstashResponse;

  if (!Array.isArray(body)) {
    throw new KeyValueStoreUnavailableError(body.error ?? "Upstash transaction failed.");
  }

  return body;
};

export const runStoreCommand = async (command: string[]): Promise<UpstashResponse> => {
  const result = await runStoreTransaction([command]);
  const first = result[0] ?? {};

  if (first.error) {
    throw new KeyValueStoreUnavailableError(first.error);
  }

  return first;
};

export const getStoreString = async (key: string): Promise<string | null> => {
  const result = await runStoreCommand(["GET", key]);
  return typeof result.result === "string" ? result.result : null;
};

export const getStoreStrings = async (keys: string[]): Promise<Array<string | null>> => {
  if (keys.length === 0) {
    return [];
  }

  const results = await runStoreTransaction(keys.map((key) => ["GET", key]));

  return results.map((result) => {
    if (result.error) {
      throw new KeyValueStoreUnavailableError(result.error);
    }

    return typeof result.result === "string" ? result.result : null;
  });
};

export const setStoreString = async (
  key: string,
  value: string,
  options?: SetOptions
): Promise<boolean> => {
  const command = ["SET", key, value];

  if (options?.nx) {
    command.push("NX");
  }

  if (options?.ttlSeconds) {
    command.push("EX", String(options.ttlSeconds));
  }

  const result = await runStoreCommand(command);
  return result.result === "OK";
};

export const deleteStoreKeys = async (...keys: string[]): Promise<void> => {
  if (keys.length === 0) {
    return;
  }

  await runStoreCommand(["DEL", ...keys]);
};

export const addStoreSetMembers = async (key: string, ...members: string[]): Promise<void> => {
  if (members.length === 0) {
    return;
  }

  await runStoreCommand(["SADD", key, ...members]);
};

export const removeStoreSetMembers = async (key: string, ...members: string[]): Promise<void> => {
  if (members.length === 0) {
    return;
  }

  await runStoreCommand(["SREM", key, ...members]);
};

export const getStoreSetMembers = async (key: string): Promise<string[]> => {
  const result = await runStoreCommand(["SMEMBERS", key]);
  return Array.isArray(result.result)
    ? result.result.filter((entry) => typeof entry === "string")
    : [];
};

const globToRegExp = (pattern: string): RegExp => {
  const escaped = pattern.replace(/[.+^${}()|[\]\\?]/gu, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${escaped}$`, "u");
};

export const countStoreKeys = async (match: string): Promise<number> => {
  if (!isKeyValueStoreConfigured()) {
    const pattern = globToRegExp(match);
    const candidateKeys = new Set([
      ...memoryValues.keys(),
      ...memorySets.keys(),
      ...memorySortedSets.keys()
    ]);
    let count = 0;

    for (const key of candidateKeys) {
      pruneExpiredMemoryKey(key);

      if (keyExists(key) && pattern.test(key)) {
        count += 1;
      }
    }

    return count;
  }

  const maxScanIterations = 200;
  let cursor = "0";
  let count = 0;

  for (let iteration = 0; iteration < maxScanIterations; iteration += 1) {
    const result = await runStoreCommand(["SCAN", cursor, "MATCH", match, "COUNT", "1000"]);
    const payload = Array.isArray(result.result) ? result.result : [];
    cursor = String(payload[0] ?? "0");
    count += isUnknownArray(payload[1]) ? payload[1].length : 0;

    if (cursor === "0") {
      return count;
    }
  }

  throw new KeyValueStoreUnavailableError("Key scan did not complete within the iteration limit.");
};

export const addStoreSortedSetMember = async (
  key: string,
  score: number,
  member: string
): Promise<void> => {
  await runStoreCommand(["ZADD", key, String(score), member]);
};

export const removeStoreSortedSetRangeByScore = async (
  key: string,
  min: number,
  max: number
): Promise<void> => {
  await runStoreCommand(["ZREMRANGEBYSCORE", key, String(min), String(max)]);
};

export const getStoreSortedSetCount = async (key: string): Promise<number> => {
  const result = await runStoreCommand(["ZCARD", key]);
  return Math.max(0, Math.floor(parseNumeric(result.result)));
};

export const getStoreSortedSetMembersWithScores = async (
  key: string,
  start: number,
  stop: number,
  order: "asc" | "desc" = "asc"
): Promise<SortedSetMemberScore[]> => {
  const command = [
    order === "desc" ? "ZREVRANGE" : "ZRANGE",
    key,
    String(start),
    String(stop),
    "WITHSCORES"
  ];
  const result = await runStoreCommand(command);

  if (!isUnknownArray(result.result)) {
    return [];
  }

  const entries: SortedSetMemberScore[] = [];
  const resultEntries = result.result;

  for (let index = 0; index < resultEntries.length; index += 2) {
    const member = resultEntries[index];
    const score = parseNumeric(resultEntries[index + 1]);

    if (typeof member === "string") {
      entries.push({ member, score });
    }
  }

  return entries;
};

const slidingWindowRateLimitScript = `
-- linkdish_sliding_window_rate_limit_v1
local key = KEYS[1]
local now_ms = tonumber(ARGV[1])
local window_start_ms = tonumber(ARGV[2])
local max_requests = tonumber(ARGV[3])
local member = ARGV[4]
local ttl_seconds = tonumber(ARGV[5])

redis.call('ZREMRANGEBYSCORE', key, 0, window_start_ms)
local count = redis.call('ZCARD', key)

if count >= max_requests then
  return {0, count}
end

redis.call('ZADD', key, now_ms, member)
redis.call('EXPIRE', key, ttl_seconds)

return {1, count + 1}
`;

const runMemorySlidingWindowRateLimit = (keys: string[], args: string[]): UpstashResponse => {
  const key = keys[0];
  const nowMs = Number(args[0]);
  const windowStartMs = Number(args[1]);
  const max = Number(args[2]);
  const member = args[3];
  const ttlSeconds = Number(args[4]);

  if (
    !key ||
    !Number.isFinite(nowMs) ||
    !Number.isFinite(windowStartMs) ||
    !Number.isFinite(max) ||
    !member ||
    !Number.isFinite(ttlSeconds)
  ) {
    return { error: "Invalid sliding-window rate limit arguments." };
  }

  pruneExpiredMemoryKey(key);

  const sortedSet = memorySortedSets.get(key) ?? new Map<string, number>();

  for (const [candidate, score] of sortedSet.entries()) {
    if (score >= 0 && score <= windowStartMs) {
      sortedSet.delete(candidate);
    }
  }

  if (sortedSet.size >= max) {
    if (sortedSet.size > 0) {
      memorySortedSets.set(key, sortedSet);
    } else {
      memorySortedSets.delete(key);
      memoryKeyExpirations.delete(key);
    }

    return { result: [0, sortedSet.size] };
  }

  sortedSet.set(member, nowMs);
  memorySortedSets.set(key, sortedSet);
  memoryKeyExpirations.set(key, nowMs + ttlSeconds * 1000);

  return { result: [1, sortedSet.size] };
};

export const runStoreEval = async (
  script: string,
  keys: string[],
  args: string[]
): Promise<UpstashResponse> => {
  if (!isKeyValueStoreConfigured()) {
    if (script.includes("linkdish_sliding_window_rate_limit_v1") && keys.length === 1) {
      return runMemorySlidingWindowRateLimit(keys, args);
    }

    if (script.includes("redis.call('get'") && keys.length === 1 && args.length === 1) {
      const currentValue = await getStoreString(keys[0] ?? "");

      if (currentValue === args[0]) {
        await deleteStoreKeys(keys[0] ?? "");
        return { result: 1 };
      }

      return { result: 0 };
    }

    return { error: "Unsupported in-memory EVAL script." };
  }

  const result = await runStoreCommand(["EVAL", script, String(keys.length), ...keys, ...args]);

  if (result.error) {
    throw new KeyValueStoreUnavailableError(result.error);
  }

  return result;
};

export const checkStoreSlidingWindowRateLimit = async ({
  key,
  max,
  member,
  nowMs,
  ttlSeconds,
  windowMs
}: SlidingWindowRateLimitOptions): Promise<SlidingWindowRateLimitResult> => {
  const result = await runStoreEval(
    slidingWindowRateLimitScript,
    [key],
    [String(nowMs), String(nowMs - windowMs), String(max), member, String(ttlSeconds)]
  );

  if (!Array.isArray(result.result)) {
    throw new KeyValueStoreUnavailableError(
      "Sliding-window rate limit returned an invalid result."
    );
  }

  return {
    allowed: parseNumeric(result.result[0]) === 1,
    count: Math.max(0, Math.floor(parseNumeric(result.result[1])))
  };
};
