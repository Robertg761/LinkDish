import React from "react";
import "./Chip.css";

interface ChipProps {
  children: React.ReactNode;
  variant?: "default" | "accent";
  className?: string;
}

export const Chip: React.FC<ChipProps> = ({ children, variant = "default", className = "" }) => {
  return (
    <span className={`chip chip-${variant} ${className}`}>
      {children}
    </span>
  );
};
