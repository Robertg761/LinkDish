import { fireEvent, render, screen } from "@testing-library/react";
import React, { useState } from "react";
import { describe, expect, it } from "vitest";

import { useRovingRadioGroup } from "./use-roving-radio";

const FRUIT = ["Apple", "Banana", "Cherry"] as const;

const Group: React.FC<{ initial?: string | undefined }> = ({ initial }) => {
  const [value, setValue] = useState<string | undefined>(initial);
  const radio = useRovingRadioGroup(FRUIT, value, setValue);

  return (
    <div aria-label="Fruit" role="radiogroup">
      {FRUIT.map((fruit, index) => (
        <button
          aria-checked={fruit === value}
          key={fruit}
          onClick={() => setValue(fruit)}
          role="radio"
          type="button"
          {...radio(index)}
        >
          {fruit}
        </button>
      ))}
    </div>
  );
};

const radioAt = (index: number): HTMLElement => {
  const radio = screen.getAllByRole("radio")[index];

  if (!radio) {
    throw new Error(`No radio at ${index}`);
  }

  return radio;
};

const tabStops = () =>
  screen.getAllByRole("radio").filter((radio) => radio.getAttribute("tabindex") === "0");

describe("useRovingRadioGroup", () => {
  it("gives the group one Tab stop: the checked option, or the first", () => {
    const { unmount } = render(<Group />);
    expect(tabStops().map((radio) => radio.textContent)).toEqual(["Apple"]);
    unmount();

    render(<Group initial="Cherry" />);
    expect(tabStops().map((radio) => radio.textContent)).toEqual(["Cherry"]);
  });

  it("moves focus and selection together with the arrow keys, Home and End", () => {
    render(<Group initial="Apple" />);
    const apple = radioAt(0);
    const banana = radioAt(1);
    const cherry = radioAt(2);

    apple.focus();
    fireEvent.keyDown(apple, { key: "ArrowDown" });
    expect(banana).toHaveFocus();
    expect(banana).toHaveAttribute("aria-checked", "true");

    fireEvent.keyDown(banana, { key: "End" });
    expect(cherry).toHaveFocus();
    expect(cherry).toHaveAttribute("aria-checked", "true");

    // Wraps around, like native radios.
    fireEvent.keyDown(cherry, { key: "ArrowRight" });
    expect(apple).toHaveFocus();

    fireEvent.keyDown(apple, { key: "ArrowUp" });
    expect(cherry).toHaveFocus();
    expect(tabStops()).toEqual([cherry]);
  });
});
