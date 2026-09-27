import React, { useId } from "react";

import "./Switch.css";

interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Visible label. When omitted, pass aria-label. */
  label?: React.ReactNode;
  description?: React.ReactNode;
  "aria-label"?: string | undefined;
  disabled?: boolean | undefined;
  className?: string | undefined;
  id?: string | undefined;
}

/** An on/off toggle (role="switch"). With a label it renders a full settings row. */
export const Switch: React.FC<SwitchProps> = ({
  checked,
  onChange,
  label,
  description,
  disabled = false,
  className = "",
  id,
  "aria-label": ariaLabel
}) => {
  const generatedId = useId();
  const switchId = id ?? `switch-${generatedId}`;
  const labelId = `${switchId}-label`;
  const descriptionId = `${switchId}-description`;

  const control = (
    <button
      aria-checked={checked}
      aria-describedby={description ? descriptionId : undefined}
      aria-label={label ? undefined : ariaLabel}
      aria-labelledby={label ? labelId : undefined}
      className={`switch${checked ? " is-on" : ""}`}
      disabled={disabled}
      id={switchId}
      onClick={() => onChange(!checked)}
      role="switch"
      type="button"
    >
      <span className="switch-thumb" aria-hidden="true" />
    </button>
  );

  if (!label) {
    return control;
  }

  return (
    <div className={`switch-row${disabled ? " is-disabled" : ""} ${className}`.trim()}>
      <div className="switch-row-copy">
        <label className="switch-row-label" htmlFor={switchId} id={labelId}>
          {label}
        </label>
        {description ? (
          <span className="switch-row-description" id={descriptionId}>
            {description}
          </span>
        ) : null}
      </div>
      {control}
    </div>
  );
};
