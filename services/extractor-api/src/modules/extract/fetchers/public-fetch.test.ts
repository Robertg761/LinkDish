import { createServer, type Server } from "node:http";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const dnsMocks = vi.hoisted(() => ({
  answers: new Map<string, Array<{ address: string; family: number }>>()
}));

vi.mock("node:dns", () => ({
  lookup: (
    hostname: string,
    _options: object,
    callback: (
      error: NodeJS.ErrnoException | null,
      addresses: Array<{ address: string; family: number }>
    ) => void
  ) => {
    const answer = dnsMocks.answers.get(hostname);

    if (answer) {
      callback(null, answer);
      return;
    }

    callback(
      Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: "ENOTFOUND" }),
      []
    );
  }
}));

const { PrivateAddressError, publicOnlyFetch, publicOnlyLookup } =
  await import("./public-fetch.js");

const lookupOnce = (hostname: string, all: boolean) =>
  new Promise<{ error: Error | null; result: unknown; family?: number }>((resolve) => {
    publicOnlyLookup(hostname, { all }, (error, result, family) => {
      resolve({ error, result, ...(family === undefined ? {} : { family }) });
    });
  });

describe("publicOnlyLookup", () => {
  it("passes public answers through in both lookup shapes", async () => {
    dnsMocks.answers.set("recipes.example", [
      { address: "93.184.216.34", family: 4 },
      { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 }
    ]);

    await expect(lookupOnce("recipes.example", true)).resolves.toEqual({
      error: null,
      result: [
        { address: "93.184.216.34", family: 4 },
        { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 }
      ]
    });
    await expect(lookupOnce("recipes.example", false)).resolves.toEqual({
      error: null,
      result: "93.184.216.34",
      family: 4
    });
  });

  it("refuses a host when any answer is private", async () => {
    dnsMocks.answers.set("rebind.example", [
      { address: "93.184.216.34", family: 4 },
      { address: "169.254.169.254", family: 4 }
    ]);

    const { error } = await lookupOnce("rebind.example", true);

    expect(error).toBeInstanceOf(PrivateAddressError);
  });
});

describe("publicOnlyFetch", () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    server = createServer((_request, response) => {
      response.end("private");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as { port: number }).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("does not connect when the hostname resolves to a private address at fetch time", async () => {
    dnsMocks.answers.set("rebound.example", [{ address: "127.0.0.1", family: 4 }]);

    const failure = await publicOnlyFetch(`http://rebound.example:${port}/`).then(
      () => null,
      (error: unknown) => error
    );

    expect(failure).toBeInstanceOf(TypeError);
    expect((failure as TypeError).cause).toBeInstanceOf(PrivateAddressError);
  });
});
