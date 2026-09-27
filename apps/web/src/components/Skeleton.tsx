import React from "react";

interface SkeletonProps {
  width?: number | string | undefined;
  height?: number | string | undefined;
  /** text = a line of copy, rect = a block (image, card), circle = an avatar. */
  shape?: "text" | "rect" | "circle" | undefined;
  radius?: number | string | undefined;
  className?: string | undefined;
  style?: React.CSSProperties | undefined;
}

/** A decorative shimmer block. Wrap groups in a role="status" region with a label. */
export const Skeleton: React.FC<SkeletonProps> = ({
  width,
  height,
  shape = "rect",
  radius,
  className = "",
  style
}) => (
  <span
    aria-hidden="true"
    className={["skeleton", `skeleton-${shape}`, className].filter(Boolean).join(" ")}
    style={{
      width,
      height: height ?? (shape === "text" ? "0.9em" : undefined),
      borderRadius: radius ?? (shape === "circle" ? "50%" : shape === "text" ? 6 : undefined),
      ...style
    }}
  />
);

interface SkeletonTextProps {
  lines?: number | undefined;
  className?: string | undefined;
}

/** Several text lines, the last one shorter, like a paragraph. */
export const SkeletonText: React.FC<SkeletonTextProps> = ({ lines = 3, className = "" }) => (
  <span aria-hidden="true" className={`skeleton-text-group ${className}`.trim()}>
    {Array.from({ length: lines }, (_, index) => (
      <Skeleton
        key={index}
        shape="text"
        width={index === lines - 1 && lines > 1 ? "62%" : "100%"}
      />
    ))}
  </span>
);
