import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ImportLinkPanel } from "./ImportLinkPanel";

const setClipboard = (text: string | DOMException, permission: PermissionState = "prompt") => {
  const readText = vi.fn(() =>
    typeof text === "string" ? Promise.resolve(text) : Promise.reject(text)
  );
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { readText }
  });
  Object.defineProperty(navigator, "permissions", {
    configurable: true,
    value: { query: vi.fn(() => Promise.resolve({ state: permission })) }
  });
  return readText;
};

const renderPanel = () => {
  const onImport = vi.fn();
  const onImportMany = vi.fn();
  const onPasteText = vi.fn();
  render(
    <ImportLinkPanel onImport={onImport} onImportMany={onImportMany} onPasteText={onPasteText} />
  );
  return { onImport, onImportMany, onPasteText };
};

const field = () => screen.getByRole("textbox", { name: "Recipe link" });

afterEach(() => {
  Reflect.deleteProperty(navigator, "clipboard");
  Reflect.deleteProperty(navigator, "permissions");
});

describe("ImportLinkPanel", () => {
  it("is a URL field that submits with Enter", () => {
    const { onImport } = renderPanel();

    expect(field()).toHaveAttribute("inputmode", "url");
    expect(field()).toHaveAttribute("enterkeyhint", "go");
    fireEvent.change(field(), { target: { value: "www.site.com/pie!" } });
    fireEvent.keyDown(field(), { key: "Enter" });

    expect(onImport).toHaveBeenCalledWith("https://www.site.com/pie");
  });

  it("explains what's wrong and keeps focus in the field", () => {
    const { onImport } = renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Get the recipe" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Paste the address of a recipe page");

    fireEvent.change(field(), { target: { value: "ftp://example.com/recipe" } });
    fireEvent.click(screen.getByRole("button", { name: "Get the recipe" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Only web links");
    expect(field()).toHaveFocus();
    expect(onImport).not.toHaveBeenCalled();
  });

  it("imports straight from the clipboard with Paste", async () => {
    setClipboard("Try this: https://example.com/soup.");
    const { onImport } = renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Paste" }));

    await waitFor(() => expect(onImport).toHaveBeenCalledWith("https://example.com/soup"));
  });

  it("hands recipe text on the clipboard to Paste text", async () => {
    setClipboard("Pancakes: 1 cup flour, 1 egg, 1 cup milk. Whisk and fry.");
    const { onImport, onPasteText } = renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Paste" }));

    await waitFor(() => expect(onPasteText).toHaveBeenCalled());
    expect(onImport).not.toHaveBeenCalled();
  });

  it("says so when the clipboard can't be read", async () => {
    setClipboard(new DOMException("denied", "NotAllowedError"));
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Paste" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("couldn't read your clipboard");
  });

  it("offers a copied link on focus when clipboard access is already allowed", async () => {
    setClipboard("https://www.seriouseats.com/chili", "granted");
    const { onImport } = renderPanel();

    await act(async () => {
      fireEvent.focus(field());
      await Promise.resolve();
    });
    fireEvent.click(await screen.findByRole("button", { name: /Use copied link/u }));

    expect(onImport).toHaveBeenCalledWith("https://www.seriouseats.com/chili");
  });

  it("never reads the clipboard on focus without permission", async () => {
    const readText = setClipboard("https://www.seriouseats.com/chili", "prompt");
    renderPanel();

    await act(async () => {
      fireEvent.focus(field());
      await Promise.resolve();
    });

    expect(readText).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /Use copied link/u })).not.toBeInTheDocument();
  });

  it("imports several links at once", () => {
    const { onImport, onImportMany } = renderPanel();

    fireEvent.change(field(), {
      target: { value: "https://a.com/one\nb.com/two\nhttps://a.com/one" }
    });
    expect(screen.getByText(/2 links from a\.com, b\.com/u)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Import 2 recipes" }));

    expect(onImportMany).toHaveBeenCalledWith(["https://a.com/one", "https://b.com/two"]);
    expect(onImport).not.toHaveBeenCalled();
  });
});
