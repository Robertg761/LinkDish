import { fireEvent, render, screen } from "@testing-library/react";
import React, { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { FilterChip } from "./Chip";
import { IconButton } from "./IconButton";
import { ProgressBar } from "./ProgressBar";
import { SearchField } from "./SearchField";
import { SegmentedControl } from "./SegmentedControl";
import { Stepper } from "./Stepper";
import { Switch } from "./Switch";

describe("SegmentedControl", () => {
  const Harness = () => {
    const [value, setValue] = useState<"system" | "light" | "dark">("system");

    return (
      <SegmentedControl
        aria-label="Theme"
        onChange={setValue}
        options={[
          { value: "system", label: "System" },
          { value: "light", label: "Light" },
          { value: "dark", label: "Dark" }
        ]}
        value={value}
      />
    );
  };

  it("behaves like a radio group with roving focus", () => {
    render(<Harness />);

    const system = screen.getByRole("radio", { name: "System" });
    expect(screen.getByRole("radiogroup", { name: "Theme" })).toBeInTheDocument();
    expect(system).toHaveAttribute("aria-checked", "true");
    expect(system).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("radio", { name: "Light" })).toHaveAttribute("tabindex", "-1");

    fireEvent.keyDown(system, { key: "ArrowRight" });

    expect(screen.getByRole("radio", { name: "Light" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "Light" })).toHaveFocus();

    fireEvent.keyDown(screen.getByRole("radio", { name: "Light" }), { key: "End" });
    expect(screen.getByRole("radio", { name: "Dark" })).toHaveAttribute("aria-checked", "true");

    fireEvent.click(screen.getByRole("radio", { name: "System" }));
    expect(screen.getByRole("radio", { name: "System" })).toHaveAttribute("aria-checked", "true");
  });
});

describe("Switch", () => {
  it("toggles and exposes its label and description", () => {
    const onChange = vi.fn();
    render(
      <Switch
        checked={false}
        description="Stops the screen from dimming."
        label="Keep screen awake"
        onChange={onChange}
      />
    );

    const control = screen.getByRole("switch", { name: "Keep screen awake" });
    expect(control).toHaveAttribute("aria-checked", "false");
    expect(control).toHaveAccessibleDescription("Stops the screen from dimming.");

    fireEvent.click(control);
    expect(onChange).toHaveBeenCalledWith(true);
  });
});

describe("Stepper", () => {
  const Harness = () => {
    const [value, setValue] = useState(2);

    return (
      <Stepper
        formatValue={(servings) => `${servings} servings`}
        label="Servings"
        max={4}
        min={1}
        onChange={setValue}
        value={value}
      />
    );
  };

  it("steps within its bounds with buttons and the keyboard", () => {
    render(<Harness />);

    const spinbutton = screen.getByRole("spinbutton", { name: "Servings" });
    expect(spinbutton).toHaveAttribute("aria-valuetext", "2 servings");

    fireEvent.click(screen.getByRole("button", { name: "Increase servings" }));
    fireEvent.click(screen.getByRole("button", { name: "Increase servings" }));

    expect(spinbutton).toHaveAttribute("aria-valuenow", "4");
    expect(screen.getByRole("button", { name: "Increase servings" })).toBeDisabled();

    fireEvent.keyDown(spinbutton, { key: "Home" });
    expect(spinbutton).toHaveAttribute("aria-valuenow", "1");
    expect(screen.getByRole("button", { name: "Decrease servings" })).toBeDisabled();

    fireEvent.keyDown(spinbutton, { key: "ArrowUp" });
    expect(spinbutton).toHaveTextContent("2 servings");
  });
});

describe("FilterChip", () => {
  it("reports its pressed state and count", () => {
    const onSelectedChange = vi.fn();
    render(
      <FilterChip count={12} onSelectedChange={onSelectedChange} selected={false}>
        Dinner
      </FilterChip>
    );

    const chip = screen.getByRole("button", { name: /dinner/i });
    expect(chip).toHaveAttribute("aria-pressed", "false");
    expect(chip).toHaveTextContent("12");

    fireEvent.click(chip);
    expect(onSelectedChange).toHaveBeenCalledWith(true);
  });
});

describe("SearchField", () => {
  const Harness = ({ onClear }: { onClear: () => void }) => {
    const [value, setValue] = useState("");

    return (
      <SearchField
        onClear={onClear}
        onValueChange={setValue}
        placeholder="Search recipes"
        shortcutHint="⌘K"
        value={value}
      />
    );
  };

  it("clears with the clear button or Escape", () => {
    const onClear = vi.fn();
    render(<Harness onClear={onClear} />);

    const input = screen.getByRole("searchbox", { name: "Search recipes" });
    expect(screen.getByText("⌘K")).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "soup" } });
    expect(screen.queryByText("⌘K")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(input).toHaveValue("");
    expect(input).toHaveFocus();

    fireEvent.change(input, { target: { value: "stew" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input).toHaveValue("");
    expect(onClear).toHaveBeenCalledTimes(2);
  });
});

describe("IconButton", () => {
  it("requires a name and supports a pressed toggle icon", () => {
    const { container } = render(
      <IconButton aria-label="Favorite" icon="heart" pressed pressedIcon="heart-filled" />
    );

    expect(screen.getByRole("button", { name: "Favorite" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    expect(container.querySelector("svg")).toHaveAttribute("data-icon", "heart-filled");
  });
});

describe("ProgressBar", () => {
  it("clamps its value and exposes progress semantics", () => {
    render(<ProgressBar label="Cooking progress" max={7} value={9} valueText="Step 7 of 7" />);

    const bar = screen.getByRole("progressbar", { name: "Cooking progress" });
    expect(bar).toHaveAttribute("aria-valuenow", "7");
    expect(bar).toHaveAttribute("aria-valuetext", "Step 7 of 7");
  });
});
