import React, { memo, useLayoutEffect, useRef } from "react";

import { FilterChip } from "../../../components/Chip";
import { Icon } from "../../../components/Icon";

import type { FilterChipModel, LibraryFilterKey } from "./library-model";

import "./LibraryFilterBar.css";

interface LibraryFilterBarProps {
  chips: readonly FilterChipModel[];
  selected: readonly LibraryFilterKey[];
  onToggle: (key: LibraryFilterKey) => void;
  onClear: () => void;
  onManageCollections: () => void;
  hasCollections: boolean;
}

/**
 * Smart filters, collections and top tags as one horizontally scrolling chip row.
 * Chips combine (AND); empty chips hide unless they are selected. Active chips move to the front
 * (right after "Clear"), so a filter chosen at the far end never hides off-screen, and the
 * collections manager leads the row where it can be found.
 */
const LibraryFilterBarComponent: React.FC<LibraryFilterBarProps> = ({
  chips,
  selected,
  onToggle,
  onClear,
  onManageCollections,
  hasCollections
}) => {
  const selectedSet = new Set(selected);
  const visible = chips.filter((chip) => chip.count > 0 || selectedSet.has(chip.key));
  const ordered = [
    ...selected.flatMap((key) => visible.filter((chip) => chip.key === key)),
    ...visible.filter((chip) => !selectedSet.has(chip.key))
  ];
  const trackRef = useRef<HTMLDivElement | null>(null);
  const selectionKey = selected.join("|");

  // A chip picked at the far end moves to the front: bring the front (Clear and the active
  // chips) into view with it, instead of leaving the row scrolled past them.
  useLayoutEffect(() => {
    const track = trackRef.current;

    if (track && track.scrollLeft > 0) {
      track.scrollLeft = 0;
    }
  }, [selectionKey]);

  return (
    <div aria-label="Filter recipes" className="library-filters" role="group">
      <div className="library-filters-track" ref={trackRef}>
        <button className="library-filters-manage" onClick={onManageCollections} type="button">
          <Icon name={hasCollections ? "folder" : "folder-plus"} size={15} />
          {hasCollections ? "Collections" : "New collection"}
        </button>
        {selected.length > 0 ? (
          <button
            aria-label={`Clear ${selected.length} ${selected.length === 1 ? "filter" : "filters"}`}
            className="library-filters-clear"
            onClick={onClear}
            type="button"
          >
            <Icon name="x" size={15} strokeWidth={2.4} />
            Clear <span className="num">({selected.length})</span>
          </button>
        ) : null}
        {ordered.map((chip) => (
          <FilterChip
            count={chip.count}
            icon={chip.emoji ? undefined : chip.icon}
            key={chip.key}
            onSelectedChange={() => onToggle(chip.key)}
            selected={selectedSet.has(chip.key)}
          >
            {chip.emoji ? (
              <span aria-hidden="true" className="library-filters-emoji">
                {chip.emoji}
              </span>
            ) : null}
            {chip.label}
          </FilterChip>
        ))}
      </div>
    </div>
  );
};

export const LibraryFilterBar = memo(LibraryFilterBarComponent);
