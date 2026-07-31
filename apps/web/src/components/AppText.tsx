import React from "react";
import "./AppText.css";

interface AppTextProps {
  variant?: "display" | "headline" | "title" | "body" | "label";
  muted?: boolean;
  as?: React.ElementType;
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}

export const AppText: React.FC<AppTextProps> = ({
  variant = "body",
  muted = false,
  as,
  children,
  className = "",
  style
}) => {
  const defaultTags: Record<string, React.ElementType> = {
    display: "h1",
    headline: "h2",
    title: "h3",
    body: "p",
    label: "span"
  };
  const Tag = as || defaultTags[variant] || "p";

  return (
    <Tag
      className={`app-text app-text-${variant} ${muted ? "app-text-muted" : ""} ${className}`}
      style={style}
    >
      {children}
    </Tag>
  );
};
