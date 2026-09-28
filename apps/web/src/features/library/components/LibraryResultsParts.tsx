import { extractFirstUrl } from "@linkdish/recipe-domain";
import React from "react";

import { Button, ButtonLink } from "../../../components/Button";
import { EmptyState } from "../../../components/EmptyState";
import { IconButton } from "../../../components/IconButton";
import { Menu } from "../../../components/Menu";

import {
  buildImportPath,
  getShortSortLabel,
  getSortLabel,
  LIBRARY_SORT_OPTIONS
} from "./library-model";

import type { LibrarySort, LibrarySortDirection, LibraryView } from "./library-model";
import type { MenuEntry } from "../../../components/Menu";

export const pluralize = (count: number, singular: string, plural = `${singular}s`): string =>
  `${count} ${count === 1 ? singular : plural}`;

interface LibraryToolbarProps {
  /** Left side: a section title or a result count. */
  heading: React.ReactNode;
  sort: LibrarySort;
  direction: LibrarySortDirection;
  /** Which sorts to offer (Family has no cook history or ratings). */
  availableSorts: ReadonlySet<LibrarySort> | null;
  showSort: boolean;
  view: LibraryView;
  onSortChange: (sort: LibrarySort) => void;
  onDirectionToggle: () => void;
  onViewChange: (view: LibraryView) => void;
}

/** "All recipes · [Sort ▾] [▦ ☰]" above the cards. */
export const LibraryToolbar: React.FC<LibraryToolbarProps> = ({
  heading,
  sort,
  direction,
  availableSorts,
  showSort,
  view,
  onSortChange,
  onDirectionToggle,
  onViewChange
}) => {
  const sortLabel = getSortLabel(sort);
  const items: MenuEntry[] = [
    { id: "sort-group", label: "Sort by", type: "separator" },
    ...LIBRARY_SORT_OPTIONS.filter(
      (option) => !availableSorts || availableSorts.has(option.value)
    ).map((option) => ({
      checked: sort === option.value,
      id: option.value,
      label: option.label,
      onSelect: () => onSortChange(option.value)
    })),
    { id: "direction-separator", type: "separator" },
    {
      checked: direction === "reverse",
      id: "reverse",
      label: "Reverse order",
      onSelect: onDirectionToggle,
      selection: "checkbox"
    }
  ];

  return (
    <div className="library-toolbar">
      {heading}
      <div className="library-toolbar-tools">
        {showSort ? (
          // On phones a bottom sheet: the long list stays in thumb reach, clear of the tab bar.
          <Menu
            items={items}
            label="Sort recipes"
            presentation="adaptive"
            sheetTitle="Sort recipes"
            renderTrigger={(props) => (
              <Button
                {...props}
                aria-label={`Sort recipes. Current: ${sortLabel}`}
                className="library-sort-button"
                icon="arrow-up-down"
                pill
                size="sm"
                trailingIcon="chevron-down"
                variant="secondary"
              >
                <span className="library-sort-label">{sortLabel}</span>
                <span aria-hidden="true" className="library-sort-label-short">
                  {getShortSortLabel(sort)}
                </span>
              </Button>
            )}
          />
        ) : null}
        <div aria-label="Layout" className="library-view-toggle" role="group">
          <IconButton
            aria-label="Grid view"
            icon="grid"
            onClick={() => onViewChange("grid")}
            pressed={view === "grid"}
            size="sm"
          />
          <IconButton
            aria-label="List view"
            icon="list"
            onClick={() => onViewChange("list")}
            pressed={view === "list"}
            size="sm"
          />
        </div>
      </div>
    </div>
  );
};

interface LibraryResultsHeadingProps {
  searchText: string;
  visibleCount: number;
  totalCount: number;
  filtered: boolean;
  title: string;
}

export const LibraryResultsHeading: React.FC<LibraryResultsHeadingProps> = ({
  searchText,
  visibleCount,
  totalCount,
  filtered,
  title
}) => {
  if (searchText) {
    return (
      <p aria-live="polite" className="library-results-count">
        <span className="num">{pluralize(visibleCount, "recipe")}</span> for “{searchText}”
      </p>
    );
  }

  if (filtered) {
    return (
      <p aria-live="polite" className="library-results-count">
        <span className="num">{visibleCount}</span> of{" "}
        <span className="num">{pluralize(totalCount, "recipe")}</span>
      </p>
    );
  }

  return (
    <h2 className="library-section-title">
      {title} <span className="library-section-count num">{totalCount}</span>
    </h2>
  );
};

interface LibraryNoResultsProps {
  searchText: string;
  filterCount: number;
  /** Matches for the query with the filters ignored. */
  unfilteredMatchCount: number;
  onClearFilters: () => void;
  onClearSearch: () => void;
}

/** No matches: explain why, and offer the quickest way out (clear filters, clear search, import). */
export const LibraryNoResults: React.FC<LibraryNoResultsProps> = ({
  searchText,
  filterCount,
  unfilteredMatchCount,
  onClearFilters,
  onClearSearch
}) => {
  if (!searchText) {
    return (
      <EmptyState
        actions={
          <Button icon="x" onClick={onClearFilters} variant="secondary">
            Clear filters
          </Button>
        }
        body="Nothing in your cookbook matches all of these filters together."
        compact
        illustration="search"
        title="No recipes match these filters"
      />
    );
  }

  const queryUrl = extractFirstUrl(searchText);

  return (
    <EmptyState
      actions={
        <>
          {queryUrl ? (
            <ButtonLink icon="link" to={buildImportPath(queryUrl)} variant="primary">
              Import this link
            </ButtonLink>
          ) : null}
          {filterCount > 0 && unfilteredMatchCount > 0 ? (
            <Button icon="filter" onClick={onClearFilters} variant="primary">
              {`Show ${pluralize(unfilteredMatchCount, "match", "matches")} without filters`}
            </Button>
          ) : null}
          <Button onClick={onClearSearch} variant="secondary">
            Clear search
          </Button>
        </>
      }
      body={
        queryUrl
          ? "That looks like a link. Import it and it will be here next time."
          : filterCount > 0
            ? "Try clearing a filter, checking the spelling, or searching by an ingredient."
            : "Check the spelling, or search by an ingredient, a tag or the site it came from."
      }
      compact
      illustration="search"
      title={`No recipes match “${searchText}”`}
    />
  );
};

/** Placeholder cards while the cookbook loads, shaped like the current view. */
export const LibrarySkeleton: React.FC<{ view: LibraryView; count?: number | undefined }> = ({
  view,
  count = 8
}) => (
  <ul aria-hidden="true" className={`library-${view} library-skeleton`}>
    {Array.from({ length: count }, (_, index) => (
      <li className="library-skeleton-card" key={index}>
        <span className="skeleton library-skeleton-image" />
        <span className="library-skeleton-copy">
          <span className="skeleton library-skeleton-line" />
          <span className="skeleton library-skeleton-line is-short" />
        </span>
      </li>
    ))}
  </ul>
);
