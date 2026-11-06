import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  injectJavaScript: vi.fn(),
  reload: vi.fn(),
  params: { url: "" },
  replace: vi.fn(),
  back: vi.fn()
}));

vi.mock("expo-router", () => ({
  router: { back: mocks.back, replace: mocks.replace },
  useLocalSearchParams: () => mocks.params
}));

vi.mock("react-native", () => ({
  StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 },
  View: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("view", null, children)
}));

vi.mock("react-native-safe-area-context", () => ({
  SafeAreaView: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("safe-area", null, children)
}));

vi.mock("@linkdish/ui", () => ({
  AppButton: (props: { label: string; disabled?: boolean; onPress: () => void }) =>
    React.createElement("button", props),
  AppText: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("text", null, children)
}));

vi.mock("../../theme/tokens", () => ({
  appColors: { background: "#fff", border: "#ddd", surface: "#fff" },
  appSpacing: { lg: 16, md: 12, sm: 8 }
}));

vi.mock("@expo/dom-webview", () => ({
  DomWebView: React.forwardRef((props: Record<string, unknown>, ref) => {
    React.useImperativeHandle(ref, () => ({
      injectJavaScript: mocks.injectJavaScript,
      reload: mocks.reload
    }));
    return React.createElement("web-view", props);
  })
}));

import OpenPageScreen from "../../../app/open-page";

import { getPendingPageImport } from "./pageImport";


(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const url = "https://www.allrecipes.com/recipe/13309/rich-and-simple-french-onion-soup/";
const recipePage =
  '<html><head><title>Soup</title><script type="application/ld+json">{"@type":"Recipe"}</script></head><body>Soup</body></html>';

const render = (): ReactTestRenderer => {
  let renderer: ReactTestRenderer | undefined;
  act(() => {
    renderer = create(<OpenPageScreen />);
  });
  return renderer!;
};

const webView = (renderer: ReactTestRenderer) =>
  renderer.root.find((node) => (node.type as unknown) === "web-view");
const buttons = (renderer: ReactTestRenderer) =>
  renderer.root
    .findAll((node) => (node.type as unknown) === "button")
    .map((node) => node.props.label as string);
const post = (renderer: ReactTestRenderer, message: object) => {
  act(() => {
    (webView(renderer).props.onMessage as (event: unknown) => void)({
      nativeEvent: { data: JSON.stringify(message) }
    });
  });
};
const shown = (renderer: ReactTestRenderer, href = url, title = "Soup") =>
  post(renderer, { type: "linkdish:page-shown", href, title });
/* Lets the page settle; returns the nonce of the capture the app then asked for. */
const settle = (ms = 1_200): string => {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
  const script = mocks.injectJavaScript.mock.lastCall?.[0] as string | undefined;
  return script ? (/nonce:"([^"]+)"/u.exec(script)?.[1] ?? "") : "";
};
const captured = (renderer: ReactTestRenderer, nonce: string, href = url, html = recipePage) =>
  post(renderer, { type: "linkdish:page-captured", nonce, href, html });
const texts = (renderer: ReactTestRenderer) =>
  renderer.root
    .findAll((node) => (node.type as unknown) === "text")
    .map((node) => String(node.props.children))
    .join(" ");

describe("OpenPageScreen", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.params = { url };
    mocks.injectJavaScript.mockReset();
    mocks.reload.mockReset();
    mocks.replace.mockReset();
    mocks.back.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens the page on screen and saves the recipe on its own once it loads", () => {
    const renderer = render();

    expect(webView(renderer).props.source).toEqual({ uri: url });
    expect(buttons(renderer)).toEqual(["Cancel"]);
    expect(mocks.injectJavaScript).not.toHaveBeenCalled();

    shown(renderer);
    const nonce = settle();
    expect(nonce).not.toBe("");
    captured(renderer, nonce);

    expect(mocks.replace).toHaveBeenCalledOnce();
    const params = (mocks.replace.mock.lastCall?.[0] as { params: Record<string, string> })
      .params;
    expect(params.url).toBe(url);
    expect(getPendingPageImport(params.pageImportId!)).toMatchObject({
      url,
      devicePage: { finalUrl: url, html: expect.stringContaining("ld+json") as string }
    });
  });

  it("waits out the site's check and saves the page it lets through", () => {
    const renderer = render();

    shown(renderer, url, "Just a moment...");
    expect(settle()).toBe("");
    expect(texts(renderer)).toContain("allrecipes.com is checking the visit");

    shown(renderer);
    captured(renderer, settle());

    expect(mocks.replace).toHaveBeenCalledOnce();
  });

  it("reads the page again while the check shows, so a check that clears in place still saves", () => {
    const renderer = render();

    shown(renderer, url, "Just a moment...");
    expect(buttons(renderer)).toEqual(["Save recipe", "Cancel"]);
    captured(renderer, settle(3_000), url, "<title>Just a moment...</title>");
    captured(renderer, settle(3_000));

    expect(mocks.replace).toHaveBeenCalledOnce();
  });

  it("offers Save after the check has shown for about a minute", () => {
    const renderer = render();
    shown(renderer, url, "Just a moment...");

    for (let attempt = 0; attempt < 20; attempt += 1) {
      captured(renderer, settle(3_000), url, "<title>Just a moment...</title>");
    }

    expect(mocks.replace).not.toHaveBeenCalled();
    expect(texts(renderer)).toContain("still checking the page");
    expect(buttons(renderer)).toEqual(["Save recipe", "Cancel"]);
  });

  it("keeps waiting when the page it read was still the check", () => {
    const renderer = render();
    shown(renderer);
    captured(renderer, settle(), url, "<title>Just a moment...</title>");

    expect(mocks.replace).not.toHaveBeenCalled();
    expect(buttons(renderer)).toEqual(["Save recipe", "Cancel"]);

    shown(renderer);
    captured(renderer, settle());
    expect(mocks.replace).toHaveBeenCalledOnce();
  });

  it("ignores page messages that don't answer its own request", () => {
    const renderer = render();

    captured(renderer, "guess");
    shown(renderer);
    settle();
    captured(renderer, "guess");

    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it("does not read pages on another site, and offers Save when reading fails", () => {
    const renderer = render();

    shown(renderer, "https://ads.example.com/");
    expect(settle()).toBe("");

    shown(renderer);
    captured(renderer, settle(), "https://ads.example.com/");

    expect(mocks.replace).not.toHaveBeenCalled();
    expect(texts(renderer)).toContain("This page isn't on allrecipes.com");
    expect(buttons(renderer)).toEqual(["Save recipe", "Cancel"]);
  });

  it("reads an empty page again before giving up", () => {
    const renderer = render();
    shown(renderer);
    captured(renderer, settle(), url, "<script>x</script>");
    captured(renderer, settle(2_000), url, "<script>x</script>");
    expect(buttons(renderer)).toEqual(["Cancel"]);
    captured(renderer, settle(2_000), url, "<script>x</script>");

    expect(buttons(renderer)).toEqual(["Save recipe", "Cancel"]);
  });

  it("saves a shortened link's recipe page, judged by where the link led", () => {
    mocks.params = { url: "https://bit.ly/onion-soup" };
    const renderer = render();

    shown(renderer, "https://bit.ly/onion-soup+");
    expect(settle()).toBe("");
    shown(renderer);
    captured(renderer, settle());

    expect(mocks.replace).toHaveBeenCalledOnce();
  });

  it("offers Try again when the page never loads, and carries on once it does", () => {
    const renderer = render();

    settle(20_000);
    expect(texts(renderer)).toContain("allrecipes.com didn't load");
    expect(buttons(renderer)).toEqual(["Try again", "Cancel"]);

    act(() => {
      (
        renderer.root.find(
          (node) => (node.type as unknown) === "button" && node.props.label === "Try again"
        ).props.onPress as () => void
      )();
    });
    expect(mocks.reload).toHaveBeenCalledOnce();
    expect(buttons(renderer)).toEqual(["Cancel"]);

    shown(renderer);
    captured(renderer, settle());
    expect(mocks.replace).toHaveBeenCalledOnce();
  });

  it("won't open a local address", () => {
    mocks.params = { url: "http://192.168.1.1/" };
    const renderer = render();

    expect(renderer.root.findAll((node) => (node.type as unknown) === "web-view")).toHaveLength(0);
    expect(texts(renderer)).toContain("can't open that link");
  });
});
