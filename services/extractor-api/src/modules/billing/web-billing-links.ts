import { createWebBillingCheckoutRequestSchema } from "../../../../../packages/api-contracts/src/index.js";
import { extractorApiEnv } from "../../config/env.js";

import type {
  AccountUser,
  BillingPeriod,
  PaidBillingPlan,
  WebBillingAvailability
} from "../../../../../packages/api-contracts/src/index.js";

type WebBillingLinkMap = Record<PaidBillingPlan, Record<BillingPeriod, string | undefined>>;

interface RevenueCatV2ListResponse<Item> {
  items: Item[];
  next_page?: string | null;
  object: "list";
  url?: string;
}

interface RevenueCatV2Subscription {
  current_period_ends_at?: number | null;
  ends_at?: number | null;
  environment?: string;
  gives_access?: boolean;
  id?: string;
  object?: string;
  status?: string;
  store?: string;
}

interface RevenueCatAuthenticatedManagementUrlResponse {
  management_url?: string;
  object?: string;
}

export class WebBillingError extends Error {
  public constructor(
    message: string,
    public readonly statusCode: number
  ) {
    super(message);
    this.name = "WebBillingError";
  }
}

const REVENUECAT_V2_API_BASE_URL = "https://api.revenuecat.com/v2";
const REVENUECAT_V2_API_ORIGIN = "https://api.revenuecat.com";
const REVENUECAT_SUBSCRIPTION_PAGE_LIMIT = 100;
const REVENUECAT_SUBSCRIPTION_PAGE_CAP = 10;
const WEB_MANAGED_STORE_HINTS = new Set(["rc_billing", "stripe"]);

const webBillingLinks = (): WebBillingLinkMap => ({
  family: {
    monthly: extractorApiEnv.REVENUECAT_WEB_PURCHASE_LINK_FAMILY_MONTHLY,
    yearly: extractorApiEnv.REVENUECAT_WEB_PURCHASE_LINK_FAMILY_YEARLY
  },
  plus: {
    monthly: extractorApiEnv.REVENUECAT_WEB_PURCHASE_LINK_PLUS_MONTHLY,
    yearly: extractorApiEnv.REVENUECAT_WEB_PURCHASE_LINK_PLUS_YEARLY
  }
});

const appendBillingPeriod = (price: string, period: BillingPeriod): string =>
  price.includes("/") ? price : `${price}/${period === "monthly" ? "month" : "year"}`;

const webBillingPrices = (): WebBillingAvailability["prices"] => ({
  family: {
    monthly: appendBillingPeriod(extractorApiEnv.FAMILY_MONTHLY_PRICE_LABEL, "monthly"),
    yearly: appendBillingPeriod(extractorApiEnv.FAMILY_YEARLY_PRICE_LABEL, "yearly")
  },
  plus: {
    monthly: appendBillingPeriod(extractorApiEnv.PLUS_MONTHLY_PRICE_LABEL, "monthly"),
    yearly: appendBillingPeriod(extractorApiEnv.PLUS_YEARLY_PRICE_LABEL, "yearly")
  }
});

const foundingLifetimeLink = (): string | undefined =>
  extractorApiEnv.REVENUECAT_WEB_PURCHASE_LINK_FOUNDING_LIFETIME;

const hasAnyCheckoutLink = (links: WebBillingLinkMap): boolean =>
  Object.values(links).some((planLinks) => Object.values(planLinks).some(Boolean));

const isDynamicRevenueCatManagementConfigured = (): boolean =>
  Boolean(extractorApiEnv.REVENUECAT_PROJECT_ID && extractorApiEnv.REVENUECAT_V2_SECRET_API_KEY);

const buildIdentifiedRevenueCatUrl = (template: string, user: AccountUser): string => {
  const encodedUserId = encodeURIComponent(user.id);
  const url = new URL(
    template.includes("{app_user_id}")
      ? template.replaceAll("{app_user_id}", encodedUserId)
      : `${template.replace(/\/+$/u, "")}/${encodedUserId}`
  );

  url.searchParams.set("email", user.email);

  return url.toString();
};

const extractRevenueCatErrorMessage = (body: unknown): string | undefined => {
  if (!body || typeof body !== "object") {
    return undefined;
  }

  const record = body as Record<string, unknown>;

  if (typeof record.message === "string") {
    return record.message;
  }

  if (typeof record.detail === "string") {
    return record.detail;
  }

  if (Array.isArray(record.errors)) {
    const messages = record.errors
      .map((error) => {
        if (!error || typeof error !== "object") {
          return undefined;
        }

        const errorRecord = error as Record<string, unknown>;

        if (typeof errorRecord.message === "string") {
          return errorRecord.message;
        }

        if (typeof errorRecord.detail === "string") {
          return errorRecord.detail;
        }

        return undefined;
      })
      .filter((message): message is string => Boolean(message));

    return messages.length > 0 ? messages.join("; ") : undefined;
  }

  return undefined;
};

const readRevenueCatV2Response = async <ResponseBody>(
  response: Response
): Promise<ResponseBody> => {
  const responseText = await response.text();
  const body = responseText ? (JSON.parse(responseText) as unknown) : undefined;

  if (!response.ok) {
    const message =
      extractRevenueCatErrorMessage(body) ??
      response.statusText ??
      "RevenueCat API request failed.";
    const statusCode =
      response.status === 401 || response.status === 403
        ? 503
        : response.status === 404
          ? 404
          : 502;

    throw new WebBillingError(
      `RevenueCat billing portal request failed (${response.status}): ${message}`,
      statusCode
    );
  }

  return body as ResponseBody;
};

const buildRevenueCatV2Url = (path: string): string => {
  if (path.startsWith("https://")) {
    const url = new URL(path);

    if (url.origin !== REVENUECAT_V2_API_ORIGIN || !url.pathname.startsWith("/v2/")) {
      throw new WebBillingError("RevenueCat returned an unexpected pagination URL.", 502);
    }

    return url.toString();
  }

  if (path.startsWith("/v2/")) {
    return `${REVENUECAT_V2_API_ORIGIN}${path}`;
  }

  return `${REVENUECAT_V2_API_BASE_URL}${path}`;
};

const fetchRevenueCatV2Response = (path: string): Promise<Response> => {
  if (!extractorApiEnv.REVENUECAT_V2_SECRET_API_KEY) {
    throw new WebBillingError("RevenueCat v2 API access is not configured yet.", 503);
  }

  return fetch(buildRevenueCatV2Url(path), {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${extractorApiEnv.REVENUECAT_V2_SECRET_API_KEY}`
    }
  });
};

const fetchRevenueCatV2 = async <ResponseBody>(path: string): Promise<ResponseBody> =>
  readRevenueCatV2Response<ResponseBody>(await fetchRevenueCatV2Response(path));

const getRevenueCatCustomerSubscriptions = async (
  user: AccountUser
): Promise<RevenueCatV2Subscription[]> => {
  const projectId = extractorApiEnv.REVENUECAT_PROJECT_ID;

  if (!projectId) {
    throw new WebBillingError("RevenueCat project ID is not configured yet.", 503);
  }

  const path =
    `/projects/${encodeURIComponent(projectId)}` +
    `/customers/${encodeURIComponent(user.id)}/subscriptions?environment=production&limit=${REVENUECAT_SUBSCRIPTION_PAGE_LIMIT}`;
  const subscriptions: RevenueCatV2Subscription[] = [];
  const visitedPages = new Set<string>();
  let nextPage: string | null | undefined = path;

  for (
    let pageCount = 0;
    nextPage && pageCount < REVENUECAT_SUBSCRIPTION_PAGE_CAP;
    pageCount += 1
  ) {
    if (visitedPages.has(nextPage)) {
      throw new WebBillingError("RevenueCat returned a repeated subscriptions page.", 502);
    }
    visitedPages.add(nextPage);

    const response = await fetchRevenueCatV2Response(nextPage);

    if (response.status === 404) {
      return subscriptions;
    }

    const body =
      await readRevenueCatV2Response<RevenueCatV2ListResponse<RevenueCatV2Subscription>>(response);
    subscriptions.push(...body.items);
    nextPage = body.next_page ?? null;
  }

  if (nextPage) {
    throw new WebBillingError("RevenueCat returned too many subscription pages.", 502);
  }

  return subscriptions;
};

const rankRevenueCatSubscription = (subscription: RevenueCatV2Subscription): number => {
  const storeRank = subscription.store && WEB_MANAGED_STORE_HINTS.has(subscription.store) ? 100 : 0;
  const statusRank =
    subscription.status === "active" ? 10 : subscription.status === "trialing" ? 9 : 0;
  const expiryRank = subscription.current_period_ends_at ?? subscription.ends_at ?? 0;

  return storeRank + statusRank + expiryRank / 1_000_000_000;
};

const isManageableRevenueCatSubscription = (
  subscription: RevenueCatV2Subscription
): subscription is RevenueCatV2Subscription & { id: string } =>
  typeof subscription.id === "string" &&
  subscription.id.length > 0 &&
  subscription.gives_access === true &&
  (!subscription.environment || subscription.environment === "production");

const createDynamicRevenueCatManagementUrl = async (user: AccountUser): Promise<string> => {
  const subscriptions = (await getRevenueCatCustomerSubscriptions(user))
    .filter(isManageableRevenueCatSubscription)
    .sort(
      (first, second) => rankRevenueCatSubscription(second) - rankRevenueCatSubscription(first)
    );

  if (subscriptions.length === 0) {
    throw new WebBillingError(
      "No active Web Billing subscription is available to manage. If you subscribed through Apple or Google Play, manage it through that store.",
      404
    );
  }

  let unexpectedError: WebBillingError | null = null;

  for (const subscription of subscriptions) {
    try {
      const body = await fetchRevenueCatV2<RevenueCatAuthenticatedManagementUrlResponse>(
        `/projects/${encodeURIComponent(extractorApiEnv.REVENUECAT_PROJECT_ID ?? "")}` +
          `/subscriptions/${encodeURIComponent(subscription.id)}/authenticated_management_url`
      );

      if (body.management_url) {
        return body.management_url;
      }
    } catch (error) {
      if (error instanceof WebBillingError && error.statusCode !== 404) {
        unexpectedError = error;
      }
    }
  }

  if (unexpectedError) {
    throw unexpectedError;
  }

  throw new WebBillingError(
    "No active Web Billing subscription is available to manage. If you subscribed through Apple or Google Play, manage it through that store.",
    404
  );
};

export const getWebBillingAvailability = (): WebBillingAvailability => {
  const links = webBillingLinks();
  const webCheckoutEnabled =
    extractorApiEnv.WEB_BILLING_CHECKOUT_ENABLED && hasAnyCheckoutLink(links);

  const availability: WebBillingAvailability = {
    managementPortalAvailable:
      Boolean(extractorApiEnv.REVENUECAT_WEB_MANAGEMENT_URL) ||
      isDynamicRevenueCatManagementConfigured(),
    plans: {
      family: {
        monthly: webCheckoutEnabled && Boolean(links.family.monthly),
        yearly: webCheckoutEnabled && Boolean(links.family.yearly)
      },
      plus: {
        monthly: webCheckoutEnabled && Boolean(links.plus.monthly),
        yearly: webCheckoutEnabled && Boolean(links.plus.yearly)
      }
    },
    prices: webBillingPrices(),
    webCheckoutEnabled
  };

  // Keep the founding block absent until the Web Purchase Link is configured so nothing about the
  // Founding Plus offer reaches clients (or the default-config contract) before Robert enables it.
  const foundingLink = foundingLifetimeLink();

  if (foundingLink) {
    availability.founding = {
      available: extractorApiEnv.WEB_BILLING_CHECKOUT_ENABLED && Boolean(foundingLink),
      priceLabel: extractorApiEnv.FOUNDING_LIFETIME_PRICE_LABEL
    };
  }

  return availability;
};

export const createWebBillingCheckoutUrl = (input: unknown, user: AccountUser): string => {
  if (!extractorApiEnv.WEB_BILLING_CHECKOUT_ENABLED) {
    throw new WebBillingError("Web checkout is not enabled yet.", 503);
  }

  const request = createWebBillingCheckoutRequestSchema.parse(input);
  const link =
    "offer" in request && request.offer === "founding"
      ? foundingLifetimeLink()
      : "plan" in request && request.plan && "period" in request && request.period
        ? webBillingLinks()[request.plan][request.period]
        : undefined;

  if (!link) {
    throw new WebBillingError("This web checkout option is not configured yet.", 404);
  }

  return buildIdentifiedRevenueCatUrl(link, user);
};

export const createWebBillingManagementUrl = async (user: AccountUser): Promise<string> => {
  if (isDynamicRevenueCatManagementConfigured()) {
    return createDynamicRevenueCatManagementUrl(user);
  }

  if (!extractorApiEnv.REVENUECAT_WEB_MANAGEMENT_URL) {
    throw new WebBillingError("Web billing management is not configured yet.", 503);
  }

  return buildIdentifiedRevenueCatUrl(extractorApiEnv.REVENUECAT_WEB_MANAGEMENT_URL, user);
};
