import type { QuotaStatus } from "@linkdish/api-contracts";

export type MonthlyQuotaFields = Pick<
  QuotaStatus,
  "monthlyLimit" | "remainingThisMonth" | "resetsAt"
>;

const formatResetDate = (value: string): string | null => {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short"
  });
};

export const hasMonthlyQuotaFields = (
  quota: MonthlyQuotaFields | null | undefined
): quota is MonthlyQuotaFields & {
  monthlyLimit: number;
  remainingThisMonth: number;
  resetsAt: string;
} =>
  typeof quota?.monthlyLimit === "number" &&
  typeof quota.remainingThisMonth === "number" &&
  typeof quota.resetsAt === "string";

export const formatMonthlyQuotaCopy = (
  quota: MonthlyQuotaFields | null | undefined,
  fallback: string
): string => {
  if (!hasMonthlyQuotaFields(quota)) {
    return fallback;
  }

  const resetDate = formatResetDate(quota.resetsAt);
  const base = `${quota.remainingThisMonth} of ${quota.monthlyLimit} left this month`;

  return resetDate ? `${base} · resets ${resetDate}` : base;
};
