import { uploadRecipePhotoRequestSchema } from "../packages/api-contracts/src/index.js";
import {
  corsJson,
  corsPreflight,
  withCors
} from "../services/extractor-api/src/http/vercel-cors.js";
import { getAuthenticatedUser } from "../services/extractor-api/src/modules/auth/auth-service.js";
import {
  getProxiedImage,
  ImageProxyError,
  parseImageProxyQuery
} from "../services/extractor-api/src/modules/image/image-proxy.js";
import {
  RECIPE_PHOTO_HEADERS,
  recipePhotoErrorStatus
} from "../services/extractor-api/src/modules/image/recipe-photo-routes.js";
import { readRecipePhoto } from "../services/extractor-api/src/modules/image/recipe-photo-store.js";
import {
  RecipePhotoError,
  storeRecipePhoto
} from "../services/extractor-api/src/modules/image/recipe-photos.js";
import {
  checkPublicEndpointRateLimit,
  RateLimitUnavailableError
} from "../services/extractor-api/src/modules/rate-limit/enforce-rate-limit.js";

import { getVercelRequestIdentity } from "./_lib/vercel-request-identity.js";

export const config = {
  maxDuration: 30
};

const imageRateLimitPolicy = {
  max: 120,
  scope: "image",
  windowMs: 60 * 1_000
} as const;

const photoUploadRateLimitPolicy = {
  max: 30,
  scope: "recipe-photo",
  windowMs: 60 * 60 * 1_000
} as const;

export function OPTIONS(request: Request) {
  return corsPreflight(request);
}

/*
 * A recipe picture (/image/photos/<file>, see vercel.json). No rate limit: the /image proxy reads
 * these from one address for everyone, and the CDN answers nearly all of them.
 */
const getRecipePhoto = async (request: Request, file: string): Promise<Response> => {
  try {
    const photo = await readRecipePhoto(file);

    return photo
      ? withCors(
          request,
          new Response(Uint8Array.from(photo), { headers: RECIPE_PHOTO_HEADERS, status: 200 })
        )
      : corsJson(request, { message: "Picture not found." }, { status: 404 });
  } catch (error) {
    console.error(error);

    return corsJson(request, { message: "Picture unavailable." }, { status: 503 });
  }
};

/** A person's own picture for a recipe (POST /image/photos). */
export async function POST(request: Request) {
  try {
    const session = await getAuthenticatedUser(request.headers);

    if (!session) {
      return corsJson(request, { message: "Sign in is required." }, { status: 401 });
    }

    const rateLimit = await checkPublicEndpointRateLimit(
      request.headers,
      photoUploadRateLimitPolicy,
      getVercelRequestIdentity(request)
    );

    if (!rateLimit.allowed) {
      return corsJson(
        request,
        { message: "Too many pictures at once. Please try again later." },
        { headers: rateLimit.headers, status: 429 }
      );
    }

    const body: unknown = await request.json().catch(() => null);
    const { dataUrl } = uploadRecipePhotoRequestSchema.parse(body);

    return corsJson(request, await storeRecipePhoto(session.user.id, dataUrl), { status: 201 });
  } catch (error) {
    const status = recipePhotoErrorStatus(error);

    if (status === null) {
      console.error(error);

      return corsJson(request, { message: "The picture couldn't be saved." }, { status: 500 });
    }

    return corsJson(
      request,
      {
        message: error instanceof RecipePhotoError ? error.message : "Choose a JPEG, PNG or WebP."
      },
      { status }
    );
  }
}

export async function GET(request: Request) {
  const photoFile = new URL(request.url).searchParams.get("photo");

  if (photoFile !== null) {
    return getRecipePhoto(request, photoFile);
  }

  try {
    const rateLimit = await checkPublicEndpointRateLimit(
      request.headers,
      imageRateLimitPolicy,
      getVercelRequestIdentity(request)
    );

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

    /*
     * Vercel's CDN only caches function responses that opt in with s-maxage or
     * CDN-Cache-Control, so without it every new device re-fetched the origin
     * image, re-encoded it with sharp and paid an Upstash rate-limit round
     * trip. The shared copy is kept for a day and then revalidated in the
     * background: the cache key is only the source URL and width, and recipe
     * sites do replace images at the same URL.
     */
    return withCors(
      request,
      new Response(body, {
        headers: {
          "cache-control": "public, max-age=31536000, immutable",
          "cdn-cache-control": "public, s-maxage=86400, stale-while-revalidate=604800",
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
