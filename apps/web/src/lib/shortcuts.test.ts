import { afterEach, describe, expect, it } from "vitest";

import {
  createShortcutMatcher,
  getShortcutDefinitions,
  isTypingTarget,
  paletteShortcutLabel,
  SEQUENCE_TIMEOUT_MS
} from "./shortcuts";

import type { ShortcutEnvironment, ShortcutKeyEvent } from "./shortcuts";

const key = (value: string, overrides: Partial<ShortcutKeyEvent> = {}): ShortcutKeyEvent => ({
  altKey: false,
  ctrlKey: false,
  defaultPrevented: false,
  key: value,
  metaKey: false,
  shiftKey: false,
  target: document.body,
  ...overrides
});

const setup = (overrides: Partial<ShortcutEnvironment> = {}) => {
  let time = 1_000;
  const environment: ShortcutEnvironment = {
    isModalOpen: () => false,
    now: () => time,
    pageHasSearchField: () => false,
    ...overrides
  };
  const matcher = createShortcutMatcher(environment);

  return {
    advance: (ms: number) => {
      time += ms;
    },
    match: (event: ShortcutKeyEvent, paletteOpen = false) => matcher.match(event, { paletteOpen })
  };
};

afterEach(() => {
  document.body.innerHTML = "";
});

describe("isTypingTarget", () => {
  it("treats text fields, editable content and open menus as typing", () => {
    document.body.innerHTML = `
      <input id="text" type="text" />
      <input id="search" type="search" />
      <input id="check" type="checkbox" />
      <textarea id="area"></textarea>
      <select id="select"></select>
      <div id="editable" contenteditable="true"></div>
      <div role="menu"><button id="menuitem">Item</button></div>
      <button id="button">Go</button>`;
    const byId = (id: string) => document.getElementById(id);
    // jsdom does not implement isContentEditable.
    Object.defineProperty(byId("editable"), "isContentEditable", { value: true });

    expect(isTypingTarget(byId("text"))).toBe(true);
    expect(isTypingTarget(byId("search"))).toBe(true);
    expect(isTypingTarget(byId("area"))).toBe(true);
    expect(isTypingTarget(byId("select"))).toBe(true);
    expect(isTypingTarget(byId("editable"))).toBe(true);
    expect(isTypingTarget(byId("menuitem"))).toBe(true);
    expect(isTypingTarget(byId("check"))).toBe(false);
    expect(isTypingTarget(byId("button"))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe("shortcut matcher", () => {
  it("opens the palette with ⌘K or Ctrl+K, even from a text field", () => {
    const { match } = setup();
    const input = document.createElement("input");

    expect(match(key("k", { metaKey: true }))).toEqual({ type: "open-palette" });
    expect(match(key("K", { ctrlKey: true, target: input }))).toEqual({ type: "open-palette" });
    expect(match(key("k", { ctrlKey: true, shiftKey: true }))).toBeNull();
  });

  it("lets ⌘K close an open palette but not stack on another dialog", () => {
    expect(setup().match(key("k", { metaKey: true }), true)).toEqual({ type: "toggle-palette" });
    expect(setup({ isModalOpen: () => true }).match(key("k", { metaKey: true }))).toBeNull();
  });

  it("maps g-then-letter sequences to destinations within the time limit", () => {
    const { advance, match } = setup();

    expect(match(key("g"))).toBeNull();
    expect(match(key("c"))).toEqual({ to: "/", type: "go" });
    expect(match(key("g"))).toBeNull();
    expect(match(key("p"))).toEqual({ to: "/plan", type: "go" });
    expect(match(key("g"))).toBeNull();
    expect(match(key("S"))).toEqual({ to: "/shopping", type: "go" });

    match(key("g"));
    advance(SEQUENCE_TIMEOUT_MS + 1);
    expect(match(key("c"))).toBeNull();
    // An unknown second key cancels the sequence.
    match(key("g"));
    expect(match(key("x"))).toBeNull();
    expect(match(key("c"))).toBeNull();
  });

  it("opens help on ?, a new import on n, and search on /", () => {
    const { match } = setup();

    expect(match(key("?", { shiftKey: true }))).toEqual({ type: "show-help" });
    expect(match(key("n"))).toEqual({ type: "new-import" });
    expect(match(key("/"))).toEqual({ type: "open-palette" });
  });

  it("leaves / to a page with its own search field", () => {
    expect(setup({ pageHasSearchField: () => true }).match(key("/"))).toBeNull();
  });

  it("stays quiet while typing, in dialogs, with modifiers, repeats or handled events", () => {
    const { match } = setup();
    const input = document.createElement("input");

    expect(match(key("n", { target: input }))).toBeNull();
    expect(match(key("?", { shiftKey: true, target: input }))).toBeNull();
    expect(match(key("n", { ctrlKey: true }))).toBeNull();
    expect(match(key("n", { altKey: true }))).toBeNull();
    expect(match(key("n", { repeat: true }))).toBeNull();
    expect(match(key("n", { defaultPrevented: true }))).toBeNull();
    expect(match(key("n", { isComposing: true }))).toBeNull();
    expect(match(key("n"), true)).toBeNull();
    expect(setup({ isModalOpen: () => true }).match(key("n"))).toBeNull();
    expect(setup({ isModalOpen: () => true }).match(key("/"))).toBeNull();

    // Typing "g" in a field never arms the sequence.
    match(key("g", { target: input }));
    expect(match(key("c"))).toBeNull();
  });

  it("describes the shortcuts for the help sheet and rail", () => {
    expect(paletteShortcutLabel(true)).toBe("⌘K");
    expect(paletteShortcutLabel(false)).toBe("Ctrl K");
    const definitions = getShortcutDefinitions(false);

    expect(definitions.find((item) => item.id === "palette")?.keys).toEqual(["Ctrl", "K"]);
    expect(definitions.find((item) => item.id === "go-plan")).toMatchObject({
      aria: "G P",
      sequence: true
    });
  });
});
