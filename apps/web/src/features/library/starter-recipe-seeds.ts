/**
 * The starter recipes, in their own small chunk for first-run seeding. Importing the whole
 * recipe-domain barrel dynamically made the bundler keep every domain module (and zod) in that
 * chunk's graph, so a first visit downloaded ~40 KB of code it never ran.
 */
export { createStarterRecipeSeedRecords } from "@linkdish/recipe-domain";
