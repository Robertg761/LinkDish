/**
 * In-tab + cross-tab change notifications for the client-side data stores.
 *
 * Writers call {@link emitDataChange} after a successful IndexedDB write. Listeners in the same tab
 * get the written records (so caches can update without re-reading), and other tabs get a small
 * BroadcastChannel message telling them to refresh that topic from IndexedDB.
 */

export type DataTopic =
  | "savedRecipes"
  | "collections"
  | "mealPlan"
  | "importQueue"
  | "cookSessions";

export interface DataChange<RecordType = unknown> {
  topic: DataTopic;
  /** Records written in this tab. Never sent across tabs. */
  upserted?: readonly RecordType[] | undefined;
  deletedIds?: readonly string[] | undefined;
  /**
   * Ids of the records another tab wrote (cross-tab changes only), so a listener can re-read just
   * those instead of the whole topic. Absent when the writer didn't say (reload everything).
   */
  upsertedIds?: readonly string[] | undefined;
  /** The change can't be applied incrementally; listeners should reload the topic. */
  reload?: boolean | undefined;
}

export type DataChangeSource = "local" | "remote";

export type DataChangeListener = (change: DataChange, source: DataChangeSource) => void;

interface BroadcastLike {
  close(): void;
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(message: unknown): void;
}

interface CrossTabMessage {
  deletedIds?: string[];
  /** Additive: tabs that don't know it ignore it and reload the whole topic, as before. */
  upsertedIds?: string[];
  topic: DataTopic;
  v: 1;
}

/** Past this many records a cross-tab change just says "reload" (a restore, a big import). */
const MAX_CROSS_TAB_IDS = 50;

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((id) => typeof id === "string");

/** The ids of written records, when every record has a string `id` and there aren't too many. */
const upsertedIdsOf = (records: readonly unknown[] | undefined): string[] | null => {
  if (!records?.length || records.length > MAX_CROSS_TAB_IDS) {
    return null;
  }

  const ids = records.map((record) =>
    typeof record === "object" && record !== null ? (record as { id?: unknown }).id : undefined
  );

  return isStringArray(ids) ? ids : null;
};

export const DATA_CHANNEL_NAME = "linkdish-data";

const TOPICS: readonly DataTopic[] = [
  "savedRecipes",
  "collections",
  "mealPlan",
  "importQueue",
  "cookSessions"
];

const listeners = new Map<DataTopic, Set<DataChangeListener>>();

type ChannelFactory = (name: string) => BroadcastLike | null;

const defaultChannelFactory: ChannelFactory = (name) => {
  if (typeof BroadcastChannel === "undefined") {
    return null;
  }

  try {
    const created = new BroadcastChannel(name);
    // Node (tests, SSR tooling) keeps the process alive for an open channel; browsers lack unref.
    (created as unknown as { unref?: () => void }).unref?.();
    return created as unknown as BroadcastLike;
  } catch {
    return null;
  }
};

let channelFactory: ChannelFactory = defaultChannelFactory;
let channel: BroadcastLike | null | undefined;

const isCrossTabMessage = (value: unknown): value is CrossTabMessage => {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const message = value as Partial<CrossTabMessage>;

  return (
    message.v === 1 &&
    typeof message.topic === "string" &&
    TOPICS.includes(message.topic) &&
    (message.deletedIds === undefined || isStringArray(message.deletedIds)) &&
    (message.upsertedIds === undefined || isStringArray(message.upsertedIds))
  );
};

const dispatch = (change: DataChange, source: DataChangeSource): void => {
  const topicListeners = listeners.get(change.topic);

  if (!topicListeners) {
    return;
  }

  for (const listener of Array.from(topicListeners)) {
    try {
      listener(change, source);
    } catch (error) {
      console.error("LinkDish data listener failed:", error);
    }
  }
};

const getChannel = (): BroadcastLike | null => {
  if (channel !== undefined) {
    return channel;
  }

  channel = channelFactory(DATA_CHANNEL_NAME);

  if (channel) {
    channel.onmessage = (event: MessageEvent) => {
      const data: unknown = event.data;

      if (!isCrossTabMessage(data)) {
        return;
      }

      dispatch(
        {
          ...(data.deletedIds ? { deletedIds: data.deletedIds } : {}),
          ...(data.upsertedIds ? { upsertedIds: data.upsertedIds } : {}),
          reload: true,
          topic: data.topic
        },
        "remote"
      );
    };
  }

  return channel;
};

/** Notifies this tab's listeners (with records) and other tabs (with a reload hint). */
export function emitDataChange<RecordType>(change: DataChange<RecordType>): void {
  dispatch(change as DataChange, "local");

  const upsertedIds = change.reload ? null : upsertedIdsOf(change.upserted);
  const message: CrossTabMessage = {
    topic: change.topic,
    v: 1,
    ...(change.deletedIds?.length ? { deletedIds: [...change.deletedIds] } : {}),
    ...(upsertedIds ? { upsertedIds } : {})
  };

  try {
    getChannel()?.postMessage(message);
  } catch {
    // A closed or unsupported channel only costs cross-tab freshness.
  }
}

export function subscribeDataChanges(topic: DataTopic, listener: DataChangeListener): () => void {
  let topicListeners = listeners.get(topic);

  if (!topicListeners) {
    topicListeners = new Set();
    listeners.set(topic, topicListeners);
  }

  topicListeners.add(listener);
  // Make sure this tab hears other tabs' writes.
  getChannel();

  return () => {
    topicListeners.delete(listener);
  };
}

/** Test seam: replaces how the cross-tab channel is created (pass `null` for the default). */
export function setDataChannelFactoryForTests(factory: ChannelFactory | null): void {
  try {
    channel?.close();
  } catch {
    // ignore
  }

  channel = undefined;
  channelFactory = factory ?? defaultChannelFactory;
}

export function resetDataChangeFeedForTests(): void {
  listeners.clear();
  setDataChannelFactoryForTests(null);
}
