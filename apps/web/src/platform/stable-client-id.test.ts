import { describe, it, expect, beforeEach } from "vitest";

import { getStableClientId } from "./stable-client-id";

describe("stable-client-id", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("should generate a stable client ID and save to localStorage", () => {
    const id1 = getStableClientId();
    expect(id1).toBeDefined();
    expect(id1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    
    // Subsequent calls return the same ID
    const id2 = getStableClientId();
    expect(id2).toBe(id1);
  });

  it("should reuse the existing client ID stored in localStorage", () => {
    const customId = "87654321-4321-1234-4321-210987654321";
    localStorage.setItem("linkdish:web:client-id:v1", customId);
    
    const id = getStableClientId();
    expect(id).toBe(customId);
  });

  it("should regenerate the ID if the stored one is malformed", () => {
    localStorage.setItem("linkdish:web:client-id:v1", "malformed-uuid");
    const id = getStableClientId();
    expect(id).not.toBe("malformed-uuid");
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });
});
