import React from "react";
import "./Card.css";

interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
  variant?: "default" | "subtle";
  ref?: React.Ref<HTMLDivElement>;
}

export const Card: React.FC<CardProps> = ({
  children,
  variant = "default",
  className = "",
  ref,
  ...props
}) => {
  return (
    <div className={`card card-${variant} ${className}`} ref={ref} {...props}>
      {children}
    </div>
  );
};
