import { describe, expect, it } from "vitest";

import { getAdminRequestToken, matchAdminCredential, parseAdminCredentials } from "./admin-auth.js";

const longToken = (prefix: string) => `${prefix}_${"0123456789abcdef".repeat(2)}`;
const basic = (username: string, token: string) => ({
  authorization: `Basic ${Buffer.from(`${username}:${token}`).toString("base64")}`
});

describe("admin credentials", () => {
  it("parses named tokens and keeps the legacy token as the admin user", () => {
    const config = parseAdminCredentials({
      ADMIN_DASHBOARD_TOKEN: longToken("legacy"),
      ADMIN_DASHBOARD_TOKENS: ` Robert:${longToken("robert")} , ops:${longToken("ops")},`
    });

    expect(config.credentials.map(({ name, source }) => ({ name, source }))).toEqual([
      { name: "robert", source: "ADMIN_DASHBOARD_TOKENS" },
      { name: "ops", source: "ADMIN_DASHBOARD_TOKENS" },
      { name: "admin", source: "ADMIN_DASHBOARD_TOKEN" }
    ]);
    expect(config.issues).toEqual([]);
  });

  it("skips malformed, duplicate and shared entries and flags short tokens", () => {
    const shared = longToken("shared");
    const config = parseAdminCredentials({
      ADMIN_DASHBOARD_TOKENS: [
        "no-separator",
        `bad name:${longToken("x")}`,
        `robert:${shared}`,
        `robert:${longToken("again")}`,
        `ops:${shared}`,
        "short:abc123"
      ].join(",")
    });

    expect(config.credentials.map((credential) => credential.name)).toEqual(["robert", "short"]);
    expect(config.issues).toHaveLength(5);
    expect(config.issues.join("\n")).not.toContain(shared);
    expect(config.issues.at(-1)).toContain("shorter than 32 characters");
  });
});

describe("admin token matching", () => {
  const { credentials } = parseAdminCredentials({
    ADMIN_DASHBOARD_TOKEN: longToken("legacy"),
    ADMIN_DASHBOARD_TOKENS: `robert:${longToken("robert")}`
  });
  const match = (headers: Record<string, string>) => {
    const token = getAdminRequestToken(headers);
    return token ? (matchAdminCredential(token, credentials)?.name ?? null) : null;
  };

  it("matches header, bearer and Basic tokens to their named user", () => {
    expect(match({ "x-admin-dashboard-token": longToken("robert") })).toBe("robert");
    expect(match({ authorization: `Bearer ${longToken("legacy")}` })).toBe("admin");
    expect(match(basic("robert", longToken("robert")))).toBe("robert");
    expect(match(basic("Robert", longToken("robert")))).toBe("robert");
    expect(match(basic("admin", longToken("legacy")))).toBe("admin");
  });

  it("rejects wrong tokens and Basic usernames that do not own the token", () => {
    expect(match({ "x-admin-dashboard-token": "wrong" })).toBeNull();
    expect(match(basic("admin", longToken("robert")))).toBeNull();
    expect(match(basic("robert", longToken("legacy")))).toBeNull();
    expect(match({ authorization: "Basic not-base64-credentials" })).toBeNull();
    expect(match({})).toBeNull();
  });
});
