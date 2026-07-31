import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export type SourceUrlRejectionReason =
  | "blocked_hostname"
  | "dns_lookup_failed"
  | "private_address"
  | "unsupported_protocol";

export type SourceUrlSafetyRejection = {
  reason: SourceUrlRejectionReason;
  safe: false;
};

export type SourceUrlSafetyResult =
  | {
      safe: true;
    }
  | SourceUrlSafetyRejection;

export type ResolveHostname = (
  hostname: string,
  options: {
    all: true;
    verbatim: true;
  }
) => Promise<Array<{ address: string; family: number }>>;

export type ValidateSourceUrl = (url: string) => Promise<SourceUrlSafetyResult>;

export const isSourceUrlRejection = (
  result: SourceUrlSafetyResult
): result is SourceUrlSafetyRejection => result.safe === false;

const blockedHostnames = new Set(["localhost", "localhost."]);

const parseIpv4Address = (address: string): number[] | null => {
  const octets = address.split(".");

  if (octets.length !== 4) {
    return null;
  }

  const parsedOctets = octets.map((octet) => Number.parseInt(octet, 10));

  if (
    parsedOctets.some(
      (octet, index) =>
        !Number.isInteger(octet) || octet < 0 || octet > 255 || String(octet) !== octets[index]
    )
  ) {
    return null;
  }

  return parsedOctets;
};

const isPrivateIpv4Address = (address: string): boolean => {
  const octets = parseIpv4Address(address);

  if (!octets) {
    return true;
  }

  const first = octets[0]!;
  const second = octets[1]!;
  const third = octets[2]!;

  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    first >= 224 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0) ||
    (first === 192 && second === 168) ||
    (first === 192 && second === 0 && third === 2) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 198 && second === 51 && third === 100) ||
    (first === 203 && second === 0 && third === 113)
  );
};

const getIpv4MappedAddress = (address: string): string | null => {
  const normalizedAddress = address.toLowerCase();
  const mappedPrefix = "::ffff:";

  return normalizedAddress.startsWith(mappedPrefix)
    ? normalizedAddress.slice(mappedPrefix.length)
    : null;
};

const isPrivateIpv6Address = (address: string): boolean => {
  const normalizedAddress = address.toLowerCase();
  const mappedIpv4Address = getIpv4MappedAddress(normalizedAddress);

  if (mappedIpv4Address) {
    return isPrivateIpv4Address(mappedIpv4Address);
  }

  if (normalizedAddress === "::" || normalizedAddress === "::1") {
    return true;
  }

  const firstHextet = Number.parseInt(normalizedAddress.split(":")[0] || "0", 16);

  return (
    !Number.isFinite(firstHextet) ||
    firstHextet === 0 ||
    firstHextet >= 0xff00 ||
    (firstHextet >= 0xfc00 && firstHextet <= 0xfdff) ||
    (firstHextet >= 0xfe80 && firstHextet <= 0xfebf)
  );
};

export const isPublicIpAddress = (address: string): boolean => {
  const ipVersion = isIP(address);

  if (ipVersion === 4) {
    return !isPrivateIpv4Address(address);
  }

  if (ipVersion === 6) {
    return !isPrivateIpv6Address(address);
  }

  return false;
};

const isBlockedHostname = (hostname: string): boolean =>
  blockedHostnames.has(hostname) || hostname.endsWith(".localhost") || hostname.endsWith(".local");

export const validatePublicSourceUrl = async (
  url: string,
  options?: {
    resolveHostname?: ResolveHostname;
  }
): Promise<SourceUrlSafetyResult> => {
  let parsedUrl: URL;

  try {
    parsedUrl = new URL(url);
  } catch {
    return {
      reason: "unsupported_protocol",
      safe: false
    };
  }

  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    return {
      reason: "unsupported_protocol",
      safe: false
    };
  }

  const hostname = parsedUrl.hostname.replace(/^\[/u, "").replace(/\]$/u, "").toLowerCase();

  if (!hostname || isBlockedHostname(hostname)) {
    return {
      reason: "blocked_hostname",
      safe: false
    };
  }

  if (isIP(hostname)) {
    return isPublicIpAddress(hostname)
      ? { safe: true }
      : {
          reason: "private_address",
          safe: false
        };
  }

  let resolvedAddresses: Array<{ address: string; family: number }>;

  try {
    const resolveHostname = (options?.resolveHostname ?? lookup) as ResolveHostname;
    resolvedAddresses = await resolveHostname(hostname, {
      all: true,
      verbatim: true
    });
  } catch {
    return {
      reason: "dns_lookup_failed",
      safe: false
    };
  }

  if (resolvedAddresses.length === 0) {
    return {
      reason: "dns_lookup_failed",
      safe: false
    };
  }

  return resolvedAddresses.every((entry) => isPublicIpAddress(entry.address))
    ? { safe: true }
    : {
        reason: "private_address",
        safe: false
      };
};
