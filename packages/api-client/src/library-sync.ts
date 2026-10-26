/**
 * The library sync API as the shared sync engine (`runLibrarySync` in @linkdish/recipe-domain)
 * sees it: changes carry their payload under `payload` instead of `recipe` / `collection`, and a
 * change the API would turn away is turned away before it is sent, so one bad item (too large, a
 * field past its limit) can't fail the whole request it is in.
 */
import { libraryChangeSchema } from "@linkdish/api-contracts";

import type { ExtractorApiClient } from "./index.js";
import type { LibraryChange } from "@linkdish/api-contracts";
import type {
  LibraryPushResult,
  LibrarySyncAdapter,
  LibrarySyncChange
} from "@linkdish/recipe-domain/src/library-sync";

export const fromLibraryChange = (change: LibraryChange): LibrarySyncChange => ({
  id: change.id,
  kind: change.kind,
  updatedAt: change.updatedAt,
  ...(change.deleted ? { deleted: true } : {}),
  ...(change.recipe ? { payload: change.recipe } : {}),
  ...(change.collection ? { payload: change.collection } : {})
});

export const toLibraryChange = (change: LibrarySyncChange): unknown => ({
  id: change.id,
  kind: change.kind,
  updatedAt: change.updatedAt,
  ...(change.baseUpdatedAt !== undefined ? { baseUpdatedAt: change.baseUpdatedAt } : {}),
  ...(change.deleted ? { deleted: true } : { [change.kind]: change.payload })
});

export interface LibrarySyncTransportOptions {
  /**
   * Makes each request (the client method is called synchronously inside it): for an app that
   * binds requests to the account they are for.
   */
  send?: (<Result>(request: () => Promise<Result>) => Promise<Result>) | undefined;
}

/** The engine's `pull` and `push` over the LinkDish API. */
export const createLibrarySyncTransport = (
  client: Pick<ExtractorApiClient, "pullLibraryChanges" | "pushLibraryChanges">,
  { send = (request) => request() }: LibrarySyncTransportOptions = {}
): Pick<LibrarySyncAdapter, "pull" | "push"> => ({
  pull: async (since) => {
    const response = await send(() => client.pullLibraryChanges(since));
    return { ...response, changes: response.changes.map(fromLibraryChange) };
  },
  push: async (changes): Promise<LibraryPushResult> => {
    const valid: LibraryChange[] = [];
    const indexes: number[] = [];
    const rejected: LibraryPushResult["rejected"] = [];

    changes.forEach((change, index) => {
      const parsed = libraryChangeSchema.safeParse(toLibraryChange(change));

      if (parsed.success) {
        valid.push(parsed.data);
        indexes.push(index);
      } else {
        rejected.push({ index, reason: "invalid" });
      }
    });

    if (valid.length === 0) {
      return { accepted: [], newer: [], rejected };
    }

    const response = await send(() => client.pushLibraryChanges({ changes: valid }));

    return {
      accepted: response.accepted,
      newer: response.newer.map(fromLibraryChange),
      rejected: [
        ...rejected,
        ...response.rejected.flatMap((refused) => {
          const index = indexes[refused.index];
          return index === undefined ? [] : [{ index, reason: refused.reason }];
        })
      ]
    };
  }
});
