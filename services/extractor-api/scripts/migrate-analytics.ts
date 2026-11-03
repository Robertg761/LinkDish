import {
  closeAnalyticsStore,
  migrateAnalyticsDatabase
} from "../src/modules/analytics/analytics-store.js";

/*
 * Applies pending analytics migrations to ANALYTICS_DATABASE_URL (from the environment or the
 * service's .env files). The API also applies them on first use, so this is for running a
 * migration ahead of a deploy or checking a database by hand.
 *
 *   pnpm --filter @linkdish/extractor-api analytics:migrate
 */
const main = async (): Promise<void> => {
  try {
    const applied = await migrateAnalyticsDatabase();

    console.log(
      applied.length === 0
        ? "Analytics database is up to date."
        : `Applied analytics migrations: ${applied.join(", ")}.`
    );
  } finally {
    await closeAnalyticsStore();
  }
};

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
