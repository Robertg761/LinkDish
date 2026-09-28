import { describe, expect, it } from "vitest";

import { formatInviteExpiry } from "./invite-links";

const NOW = Date.parse("2026-09-28T09:00:00.000Z");
const inHours = (hours: number) => new Date(NOW + hours * 3_600_000).toISOString();

describe("formatInviteExpiry", () => {
  it("says every expiry relatively, never mixing in a timestamp", () => {
    expect(formatInviteExpiry(inHours(5 * 24), NOW)).toBe("Expires in 5 days");
    expect(formatInviteExpiry(inHours(30), NOW)).toBe("Expires tomorrow");
    expect(formatInviteExpiry(inHours(5), NOW)).toBe("Expires in 5 hours");
    expect(formatInviteExpiry(inHours(1.2), NOW)).toBe("Expires in 1 hour");
    expect(formatInviteExpiry(inHours(0.4), NOW)).toBe("Expires within the hour");
    expect(formatInviteExpiry(inHours(-1), NOW)).toBe("Expired");
    expect(formatInviteExpiry("not a date", NOW)).toBe("Expiry unknown");
  });
});
