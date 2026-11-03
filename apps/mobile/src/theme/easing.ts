import { Easing } from "react-native";

// React Native 0.88 types the built-in easings as methods, which trips
// `@typescript-eslint/unbound-method` when they are passed around by reference.
// These wrappers keep the same curves while calling them through `Easing`.
const cubic = (t: number): number => Easing.cubic(t);

export const easeInCubic = (t: number): number => Easing.in(cubic)(t);
export const easeOutCubic = (t: number): number => Easing.out(cubic)(t);
export const easeInOutCubic = (t: number): number => Easing.inOut(cubic)(t);
