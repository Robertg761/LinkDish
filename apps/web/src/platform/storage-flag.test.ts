import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createStorageFlag, useStorageFlag } from "./storage-flag";

const KEY = "linkdish:web:test-flag:v1";

const storageEvent = (key: string | null) => {
  act(() => {
    window.dispatchEvent(new StorageEvent("storage", { key, newValue: key ? "true" : null }));
  });
};

describe("storage flag", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("persists the flag and re-renders the components following it", () => {
    const flag = createStorageFlag(KEY);
    const { result } = renderHook(() => useStorageFlag(flag));
    expect(result.current).toBe(false);

    act(() => {
      flag.set();
    });

    expect(result.current).toBe(true);
    expect(localStorage.getItem(KEY)).toBe("true");
  });

  it("tells subscribers once, not on every repeat", () => {
    const flag = createStorageFlag(KEY);
    const listener = vi.fn();
    flag.subscribe(listener);

    flag.set();
    flag.set();

    expect(listener).toHaveBeenCalledOnce();
  });

  it("follows other tabs, ignoring their unrelated keys", () => {
    const flag = createStorageFlag(KEY);
    const { result } = renderHook(() => useStorageFlag(flag));

    localStorage.setItem("linkdish:web:something-else", "true");
    storageEvent("linkdish:web:something-else");
    expect(result.current).toBe(false);

    localStorage.setItem(KEY, "true");
    storageEvent(KEY);
    expect(result.current).toBe(true);

    localStorage.clear();
    storageEvent(null);
    expect(result.current).toBe(false);
  });

  it("keeps the flag for this page load when storage refuses the write", () => {
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new DOMException("QuotaExceededError");
    });
    const flag = createStorageFlag(KEY);
    const { result } = renderHook(() => useStorageFlag(flag));

    act(() => {
      flag.set();
    });

    expect(result.current).toBe(true);
    flag.resetForTests();
    expect(flag.read()).toBe(false);
  });

  it("stops listening to other tabs once nothing follows the flag", () => {
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    const flag = createStorageFlag(KEY);

    const first = flag.subscribe(() => undefined);
    const second = flag.subscribe(() => undefined);
    expect(add.mock.calls.filter(([type]) => type === "storage")).toHaveLength(1);

    first();
    expect(remove.mock.calls.filter(([type]) => type === "storage")).toHaveLength(0);
    second();
    expect(remove.mock.calls.filter(([type]) => type === "storage")).toHaveLength(1);
  });
});
