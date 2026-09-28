import React, { memo } from "react";

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
 * Chips combine (AND); empty chips hide unless they are selected.
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

  return (
    <div aria-label="Filter recipes" className="library-filters" role="group">
      <div className="library-filters-track">
        {selected.length > 0 ? (
          <button className="library-filters-clear" onClick={onClear} type="button">
            <Icon name="x" size={15} strokeWidth={2.4} />
            Clear
          </button>
        ) : null}
        {visible.map((chip) => (
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
        <button className="library-filters-manage" onClick={onManageCollections} type="button">
          <Icon name={hasCollections ? "folder" : "folder-plus"} size={15} />
          {hasCollections ? "Collections" : "New collection"}
        </button>
      </div>
    </div>
  );
};

export const LibraryFilterBar = memo(LibraryFilterBarComponent);
