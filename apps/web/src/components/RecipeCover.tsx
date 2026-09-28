import React, { useSyncExternalStore } from "react";

import { Icon } from "./Icon";

import type { IconName } from "./Icon";
import type { RecipeCourse, inferRecipeTags } from "@linkdish/recipe-domain/src/tagging";

import "./RecipeCover.css";

type CoverTone = "sage" | "butter" | "tomato";

const TONES: readonly CoverTone[] = ["sage", "butter", "tomato"];

/** Sweet and morning dishes on butter, mains on sage, light bites and drinks on tomato. */
const COURSE_ART: Record<RecipeCourse, { icon: IconName; tone: CoverTone }> = {
  baking: { icon: "wheat", tone: "butter" },
  breakfast: { icon: "egg-fried", tone: "butter" },
  dessert: { icon: "cake-slice", tone: "butter" },
  dinner: { icon: "cooking-pot", tone: "sage" },
  drink: { icon: "cup-soda", tone: "tomato" },
  lunch: { icon: "sandwich", tone: "tomato" },
  side: { icon: "salad", tone: "sage" },
  snack: { icon: "cookie", tone: "tomato" }
};

/** No known course: fork and knife, in a tone picked from the title so a grid isn't one color. */
const toneForTitle = (title: string): CoverTone => {
  let hash = 0;

  for (const char of title) {
    hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 1_000_003;
  }

  return TONES[hash % TONES.length] ?? "sage";
};

let inferTags: typeof inferRecipeTags | null = null;
const courseRulesListeners = new Set<() => void>();

/**
 * The course rules (long word lists) load beside the Cookbook rather than in its first download:
 * the art is decoration. The request starts as soon as this module runs, well before saved
 * recipes come back from storage, so covers normally draw with their course straight away; until
 * then (or if it can't load) a cover shows the neutral fork-and-knife plate. The tagging module
 * directly, not the package index, which would bring the whole domain engine (schemas, zod).
 */
export const coverCourseRulesReady: Promise<void> =
  import("@linkdish/recipe-domain/src/tagging").then(
    (module) => {
      inferTags = module.inferRecipeTags;
      courseRulesListeners.forEach((listener) => listener());
    },
    () => undefined
  );

const subscribeToCourseRules = (listener: () => void) => {
  courseRulesListeners.add(listener);
  return () => {
    courseRulesListeners.delete(listener);
  };
};

const courseRulesLoaded = () => inferTags !== null;

const courseCache = new Map<string, RecipeCourse | null>();

/**
 * The course a title names ("… Cookies" → dessert), cached: covers render in long grids. Null
 * until the course rules have loaded.
 */
export const inferCourseFromTitle = (title: string): RecipeCourse | null => {
  if (!inferTags) {
    return null;
  }

  const key = title.trim().toLowerCase();
  const cached = courseCache.get(key);

  if (cached !== undefined) {
    return cached;
  }

  const course = inferTags({ ingredients: [], steps: [], title: key }).course?.value ?? null;

  if (courseCache.size > 500) {
    courseCache.clear();
  }

  courseCache.set(key, course);
  return course;
};

export interface RecipeCoverProps {
  /** Recipe title: picks the course (and so the art) when `course` is not given. */
  title: string;
  /** A course inferred from the whole recipe (more accurate than the title alone). */
  course?: RecipeCourse | null | undefined;
  className?: string | undefined;
}

/**
 * The designed stand-in for a recipe without a photo: a plate on a gingham cloth with a
 * course-appropriate mark (a cake slice for desserts, a pot for dinners…). It fills its box and
 * scales with it (container units), from a 32px thumbnail to the recipe hero. Decorative.
 */
export const RecipeCover: React.FC<RecipeCoverProps> = ({ title, course, className = "" }) => {
  // Draws again once the course rules arrive (only the first covers after a cold start wait).
  const rulesLoaded = useSyncExternalStore(
    subscribeToCourseRules,
    courseRulesLoaded,
    courseRulesLoaded
  );
  const resolved =
    course === undefined ? (rulesLoaded ? inferCourseFromTitle(title) : null) : course;
  const art = resolved
    ? COURSE_ART[resolved]
    : { icon: "utensils" as const, tone: toneForTitle(title.trim().toLowerCase()) };

  return (
    <span
      aria-hidden="true"
      className={["recipe-cover", `is-${art.tone}`, className].filter(Boolean).join(" ")}
      data-course={resolved ?? "any"}
    >
      <span className="recipe-cover-plate">
        <Icon className="recipe-cover-icon" name={art.icon} strokeWidth={1.6} />
      </span>
    </span>
  );
};
