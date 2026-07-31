import {
  corsJson,
  corsPreflight,
  withCors
} from "../services/extractor-api/src/http/vercel-cors.js";
import {
  getProxiedImage,
  ImageProxyError,
  parseImageProxyQuery
} from "../services/extractor-api/src/modules/image/image-proxy.js";
import {
  checkPublicEndpointRateLimit,
  RateLimitUnavailableError
} from "../services/extractor-api/src/modules/rate-limit/enforce-rate-limit.js";

export const config = {
  maxDuration: 30
};

const imageRateLimitPolicy = {
  max: 120,
  scope: "image",
  windowMs: 60 * 1_000
} as const;

export function OPTIONS(request: Request) {
  return corsPreflight(request);
}

export async function GET(request: Request) {
  try {
    const rateLimit = await checkPublicEndpointRateLimit(request.headers, imageRateLimitPolicy);

    if (!rateLimit.allowed) {
      return corsJson(
        request,
        {
          message: "Too many image requests. Please try again later.",
          reason: "source_unreachable"
        },
        {
          headers: rateLimit.headers,
          status: 429
        }
      );
    }

    const { sourceUrl, width } = parseImageProxyQuery(
      Object.fromEntries(new URL(request.url).searchParams)
    );
    const image = await getProxiedImage(sourceUrl, width);
    const body = Uint8Array.from(image);

    return withCors(
      request,
      new Response(body, {
        headers: {
          "cache-control": "public, max-age=31536000, immutable",
          "content-type": "image/webp"
        },
        status: 200
      })
    );
  } catch (error) {
    if (error instanceof RateLimitUnavailableError) {
      return corsJson(
        request,
        {
          message: "Image service is temporarily unavailable.",
          reason: "source_unreachable"
        },
        {
          status: 503
        }
      );
    }

    if (error instanceof ImageProxyError) {
      return corsJson(
        request,
        {
          message: error.message,
          reason: error.reason
        },
        {
          status: error.statusCode
        }
      );
    }

    console.error(error);

    return corsJson(
      request,
      {
        message: "Image could not be proxied.",
        reason: "source_unreachable"
      },
      {
        status: 502
      }
    );
  }
}
