import React from "react";

import "./ProgressBar.css";

interface ProgressBarProps {
  value: number;
  max?: number | undefined;
  /** Accessible name, e.g. "Cooking progress". */
  label: string;
  /** Human-friendly value text, e.g. "Step 2 of 7". */
  valueText?: string | undefined;
  tone?: "primary" | "tomato" | "butter" | undefined;
  size?: "sm" | "md" | undefined;
  className?: string | undefined;
}

export const ProgressBar: React.FC<ProgressBarProps> = ({
  value,
  max = 100,
  label,
  valueText,
  tone = "primary",
  size = "md",
  className = ""
}) => {
  const safeMax = max > 0 ? max : 1;
  const clamped = Math.min(safeMax, Math.max(0, value));
  const percent = (clamped / safeMax) * 100;

  return (
    <div
      aria-label={label}
      aria-valuemax={safeMax}
      aria-valuemin={0}
      aria-valuenow={clamped}
      aria-valuetext={valueText}
      className={["progress", `progress-${tone}`, `progress-${size}`, className].join(" ").trim()}
      role="progressbar"
    >
      <span className="progress-fill" style={{ width: `${percent}%` }} />
    </div>
  );
};
