import { describe, expect, it } from "vitest";

import { isUnreadableStoredList } from "./storedList";

describe("isUnreadableStoredList", () => {
  it("accepts nothing stored and any JSON list", () => {
    expect(isUnreadableStoredList(null)).toBe(false);
    expect(isUnreadableStoredList("")).toBe(false);
    expect(isUnreadableStoredList("[]")).toBe(false);
    expect(isUnreadableStoredList('[{"id":"a"}]')).toBe(false);
  });

  it("flags a truncated or non-list value", () => {
    expect(isUnreadableStoredList('[{"id":"a"')).toBe(true);
    expect(isUnreadableStoredList('{"id":"a"}')).toBe(true);
  });
});
