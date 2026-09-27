/**
 * The shell's search button (and later ⌘K) asks for the command palette through a
 * window CustomEvent, so the palette can live in its own lazily loaded module.
 */
export const OPEN_COMMAND_PALETTE_EVENT = "linkdish:open-command-palette";

export interface OpenCommandPaletteDetail {
  /** Where the request came from, for analytics. */
  source: "rail_search" | "keyboard" | "other";
}

export const requestCommandPalette = (
  detail: OpenCommandPaletteDetail = { source: "other" }
): void => {
  window.dispatchEvent(
    new CustomEvent<OpenCommandPaletteDetail>(OPEN_COMMAND_PALETTE_EVENT, { detail })
  );
};
