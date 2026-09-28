import {
  COOK_SESSIONS_STORE_NAME,
  getLinkDishWebDb,
  IMPORT_QUEUE_STORE_NAME
} from "../storage/linkdish-db";

import { subscribeDataChanges } from "./change-feed";

import type { DataTopic } from "./change-feed";

/*
 * Some shell UI only matters when there is data behind it: the kitchen timer dock (timers live in
 * cook sessions) and the import queue count on Add. Most visits have neither, so the shell loads
 * that UI (and its chunks) only when the store holds records, or as soon as this tab or another
 * one writes to it. The shell loads this module on demand, once the first screen has settled.
 */

const whenStoreHasRecords = (
  storeName: string,
  topic: DataTopic,
  onActive: () => void
): (() => void) => {
  let done = false;
  let unsubscribe: () => void = () => undefined;

  const activate = () => {
    if (done) {
      return;
    }

    done = true;
    unsubscribe();
    onActive();
  };

  unsubscribe = subscribeDataChanges(topic, activate);

  Promise.resolve()
    .then(() => getLinkDishWebDb())
    .then((db) => db.count(storeName))
    .then(
      (count) => {
        if (count > 0) {
          activate();
        }
      },
      // Storage unavailable: load the UI anyway, it reports what it can.
      activate
    );

  return () => {
    done = true;
    unsubscribe();
  };
};

/** Calls `onActive` once a cook session (where kitchen timers are kept) exists or is written. */
export const whenKitchenTimersMayExist = (onActive: () => void): (() => void) =>
  whenStoreHasRecords(COOK_SESSIONS_STORE_NAME, "cookSessions", onActive);

/** Calls `onActive` once the import queue holds a link or one is added. */
export const whenImportQueueMayHaveItems = (onActive: () => void): (() => void) =>
  whenStoreHasRecords(IMPORT_QUEUE_STORE_NAME, "importQueue", onActive);
