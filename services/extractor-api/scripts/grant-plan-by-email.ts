import {
  AdminBillingGrantError,
  adminBillingGrantRequestSchema,
  grantBillingPlanByEmail
} from "../src/modules/admin/billing-grants.js";

const usage = `Usage:
  pnpm --filter @linkdish/extractor-api grant:plan -- --email user@example.com --plan family --days 365 --confirm
  pnpm --filter @linkdish/extractor-api grant:plan -- --email user@example.com --plan plus --until 2026-12-31T23:59:59.000Z --confirm

Without --confirm this command runs as a dry run and does not call RevenueCat.`;

const readArgs = (argv: string[]): Record<string, string | true> => {
  const args: Record<string, string | true> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--") {
      continue;
    }

    if (!arg?.startsWith("--")) {
      throw new Error(`Unexpected argument: ${arg ?? ""}`);
    }

    const key = arg.slice(2);

    if (key === "confirm" || key === "dry-run" || key === "help") {
      args[key] = true;
      continue;
    }

    const value = argv[index + 1];

    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}.`);
    }

    args[key] = value;
    index += 1;
  }

  return args;
};

const main = async () => {
  const args = readArgs(process.argv.slice(2));

  if (args.help) {
    console.log(usage);
    return;
  }

  const parsedRequest = adminBillingGrantRequestSchema.safeParse({
    dryRun: args.confirm !== true,
    durationDays: typeof args.days === "string" ? Number(args.days) : undefined,
    email: args.email,
    expiresAt: args.until,
    plan: args.plan
  });

  if (!parsedRequest.success) {
    console.error(usage);
    console.error("\nInvalid billing grant request:");
    for (const issue of parsedRequest.error.issues) {
      console.error(`- ${issue.path.join(".") || "request"}: ${issue.message}`);
    }
    process.exitCode = 1;
    return;
  }

  const result = await grantBillingPlanByEmail(parsedRequest.data, {
    grantedBy: "admin-cli"
  });

  console.log(JSON.stringify(result, null, 2));

  if (result.dryRun) {
    console.log("\nDry run only. Add --confirm to grant the entitlement in RevenueCat.");
  }
};

main().catch((error: unknown) => {
  if (error instanceof AdminBillingGrantError) {
    console.error(error.message);

    if (error.detail) {
      console.error(error.detail);
    }

    process.exit(1);
  }

  console.error(error);
  process.exit(1);
});
