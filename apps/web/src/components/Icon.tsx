import React from "react";

interface IconProps {
  name: string;
  size?: number;
  color?: string;
  className?: string;
}

export const Icon: React.FC<IconProps> = ({ name, size = 24, color, className = "" }) => {
  return (
    <span
      className={`mdi mdi-${name} ${className}`}
      style={{ fontSize: size, color, lineHeight: 1, verticalAlign: "middle" }}
      aria-hidden="true"
    />
  );
};
