import { lookup as dnsLookup } from "node:dns";

import { Agent, fetch as undiciFetch } from "undici";

import { isPublicIpAddress } from "../source-url-safety.js";

import type { LookupAddress } from "node:dns";
import type { LookupFunction } from "node:net";

/*
 * validatePublicSourceUrl resolves a hostname before the request, but fetch() resolves it
 * again when it connects. A rebinding DNS server can answer the first lookup with a public
 * address and the second with a private one. Resolving inside the connection and refusing
 * any private answer there means the address that was checked is the address connected to.
 *
 * IP-literal hosts never reach this lookup; validatePublicSourceUrl rejects private ones.
 */
export class PrivateAddressError extends Error {
  public readonly code = "ERR_PRIVATE_ADDRESS";

  public constructor(hostname: string) {
    super(`Refused to connect to ${hostname}: it resolves to a non-public address.`);
    this.name = "PrivateAddressError";
  }
}

export const publicOnlyLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true, verbatim: true }, (error, addresses) => {
    if (error) {
      callback(error, "", 0);
      return;
    }

    const resolved: LookupAddress[] = addresses;

    if (resolved.length === 0) {
      const notFound = Object.assign(new Error(`No addresses found for ${hostname}.`), {
        code: "ENOTFOUND"
      });
      callback(notFound, "", 0);
      return;
    }

    if (!resolved.every((entry) => isPublicIpAddress(entry.address))) {
      callback(new PrivateAddressError(hostname), "", 0);
      return;
    }

    if (options.all) {
      callback(null, resolved);
      return;
    }

    const [first] = resolved;
    callback(null, first!.address, first!.family);
  });
};

let publicOnlyAgent: Agent | null = null;

const getPublicOnlyAgent = () => {
  publicOnlyAgent ??= new Agent({ connect: { lookup: publicOnlyLookup } });
  return publicOnlyAgent;
};

/** fetch() for user-supplied URLs: refuses to connect to hosts that resolve to private addresses. */
export const publicOnlyFetch: typeof fetch = (input, init) =>
  undiciFetch(input as Parameters<typeof undiciFetch>[0], {
    ...(init as Parameters<typeof undiciFetch>[1]),
    dispatcher: getPublicOnlyAgent()
  }) as unknown as Promise<Response>;
