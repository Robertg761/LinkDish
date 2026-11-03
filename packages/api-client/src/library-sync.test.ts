import { describe, expect, it, vi } from "vitest";

import { SAMPLE_RECIPES } from "../../recipe-domain/src/samples.js";

import { createLibrarySyncTransport } from "./library-sync.js";

import type { ExtractorApiClient } from "./index.js";

const payload = {
  createdAt: "2026-10-01T12:00:00.000Z",
  fetchMode: "http",
  provenance: ["jsonld"],
  recipe: SAMPLE_RECIPES[0].recipe,
  strategy: "recipe-schema",
  warnings: []
};

const createClient = () => ({
  pullLibraryChanges: vi.fn<ExtractorApiClient["pullLibraryChanges"]>(),
  pushLibraryChanges: vi.fn<ExtractorApiClient["pushLibraryChanges"]>()
});

describe("library sync transport", () => {
  it("pulls changes with their payload where the sync engine reads it", async () => {
    const client = createClient();
    client.pullLibraryChanges.mockResolvedValue({
      changes: [
        {
          collection: { createdAt: "2026-10-01T12:00:00.000Z", name: "Weeknights", sortOrder: 0 },
          id: "c1",
          kind: "collection",
          updatedAt: "2026-10-26T10:00:00.000Z"
        },
        { deleted: true, id: "r1", kind: "recipe", updatedAt: "2026-10-26T10:00:00.000Z" }
      ],
      cursor: "2",
      hasMore: false
    });
    let sent = 0;
    const send = <Result>(request: () => Promise<Result>): Promise<Result> => {
      sent += 1;
      return request();
    };

    const page = await createLibrarySyncTransport(client, { send }).pull("0");

    expect(sent).toBe(1);
    expect(client.pullLibraryChanges).toHaveBeenCalledWith("0");
    expect(page).toEqual({
      changes: [
        {
          id: "c1",
          kind: "collection",
          payload: { createdAt: "2026-10-01T12:00:00.000Z", name: "Weeknights", sortOrder: 0 },
          updatedAt: "2026-10-26T10:00:00.000Z"
        },
        { deleted: true, id: "r1", kind: "recipe", updatedAt: "2026-10-26T10:00:00.000Z" }
      ],
      cursor: "2",
      hasMore: false
    });
  });

  it("turns away an invalid change before sending, and maps the API's answer back", async () => {
    const client = createClient();
    client.pushLibraryChanges.mockResolvedValue({
      accepted: [{ id: "ok", kind: "recipe" }],
      newer: [],
      rejected: [
        { id: "full", index: 1, kind: "recipe", message: "Full.", reason: "limit_reached" }
      ]
    });

    const result = await createLibrarySyncTransport(client).push([
      {
        id: "bad",
        kind: "recipe",
        payload: { ...payload, rating: 9 },
        updatedAt: "2026-10-26T10:00:00.000Z"
      },
      { id: "ok", kind: "recipe", payload, updatedAt: "2026-10-26T10:00:00.000Z" },
      { id: "full", kind: "recipe", payload, updatedAt: "2026-10-26T10:00:00.000Z" }
    ]);

    const sent = client.pushLibraryChanges.mock.calls[0]?.[0].changes;
    expect(sent?.map((change) => [change.id, change.recipe?.createdAt])).toEqual([
      ["ok", payload.createdAt],
      ["full", payload.createdAt]
    ]);
    expect(result).toEqual({
      accepted: [{ id: "ok", kind: "recipe" }],
      newer: [],
      rejected: [
        { index: 0, reason: "invalid" },
        { index: 2, reason: "limit_reached" }
      ]
    });
  });

  it("sends nothing when every change is invalid", async () => {
    const client = createClient();

    await expect(
      createLibrarySyncTransport(client).push([
        {
          id: "bad",
          kind: "collection",
          payload: { name: "" },
          updatedAt: "2026-10-26T10:00:00.000Z"
        }
      ])
    ).resolves.toEqual({ accepted: [], newer: [], rejected: [{ index: 0, reason: "invalid" }] });
    expect(client.pushLibraryChanges).not.toHaveBeenCalled();
  });
});
