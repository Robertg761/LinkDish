/**
 * Helpers that turn the API's display price labels ("$2.99/month", "$24.99/year") into the
 * numbers the pricing UI shows: a per-month equivalent for yearly plans and an honest savings
 * percentage. Every figure is derived from the labels we were given; when a label can't be read
 * (an unusual currency format, say) the helpers return null and the UI shows the label as-is.
 */

export interface ParsedPriceLabel {
  /** Numeric amount, e.g. 2.99. */
  amount: number;
  /** Everything before the number, e.g. "$" or "CA$". */
  prefix: string;
  /** Currency text after the number (before any "/period"), e.g. " USD" or " €". */
  suffix: string;
  decimalSeparator: "." | ",";
}

// "$2.99/month", "CA$ 24.99 / year", "2,99 €/mois", "$29.99".
const PRICE_LABEL_PATTERN = /^\s*([^\d\s]*)\s*(\d{1,6}(?:[.,]\d{1,2})?)(\s*[^/\d]*?)\s*(?:\/.*)?$/u;

export const parsePriceLabel = (label: string): ParsedPriceLabel | null => {
  const match = PRICE_LABEL_PATTERN.exec(label);

  if (!match) {
    return null;
  }

  const [, prefix = "", rawAmount = "", suffix = ""] = match;
  const decimalSeparator: "." | "," = rawAmount.includes(",") ? "," : ".";
  const amount = Number(rawAmount.replace(",", "."));

  if (!Number.isFinite(amount) || amount < 0) {
    return null;
  }

  return { amount, decimalSeparator, prefix, suffix: suffix.trimEnd() };
};

/** Formats an amount in the same currency style as a parsed label (always two decimals). */
export const formatPriceLike = (price: ParsedPriceLabel, amount: number): string => {
  const fixed = (Math.round(amount * 100) / 100).toFixed(2);
  const localized = price.decimalSeparator === "," ? fixed.replace(".", ",") : fixed;

  return `${price.prefix}${localized}${price.suffix}`;
};

/** The price without its billing period: "$24.99/year" → "$24.99". */
export const getPriceAmountLabel = (label: string): string => {
  const parsed = parsePriceLabel(label);

  if (!parsed) {
    return label;
  }

  return formatPriceLike(parsed, parsed.amount);
};

const sameCurrency = (left: ParsedPriceLabel, right: ParsedPriceLabel): boolean =>
  left.prefix === right.prefix && left.suffix.trim() === right.suffix.trim();

/** What a yearly price works out to per month: "$24.99/year" → "$2.08". */
export const getMonthlyEquivalentLabel = (yearlyLabel: string): string | null => {
  const yearly = parsePriceLabel(yearlyLabel);

  if (!yearly || yearly.amount <= 0) {
    return null;
  }

  return formatPriceLike(yearly, yearly.amount / 12);
};

/**
 * How much cheaper a year is than twelve monthly payments, rounded down to a whole percent so we
 * never overstate the saving. Null when the labels can't be compared or yearly isn't cheaper.
 */
export const getYearlySavingsPercent = (
  monthlyLabel: string,
  yearlyLabel: string
): number | null => {
  const monthly = parsePriceLabel(monthlyLabel);
  const yearly = parsePriceLabel(yearlyLabel);

  if (!monthly || !yearly || !sameCurrency(monthly, yearly) || monthly.amount <= 0) {
    return null;
  }

  const fullYear = monthly.amount * 12;
  const percent = Math.floor(((fullYear - yearly.amount) / fullYear) * 100 + 1e-9);

  return percent > 0 ? percent : null;
};
