const allowedOrigins = new Set([
  "http://localhost:5173",
  "https://app.linkdish.ca",
  "https://app.linkdish.xyz",
  "https://linkdish.ca",
  "https://linkdish-web.vercel.app",
  "https://linkdish.xyz",
  "https://www.linkdish.ca",
  "https://www.linkdish.xyz"
]);

const getAllowedOrigin = (request: Request): string => {
  const origin = request.headers.get("origin");
  return origin && allowedOrigins.has(origin) ? origin : "https://linkdish.ca";
};

/*
 * Every web /extract and /household call carries custom x-linkdish-* headers
 * and therefore needs a preflight. Browsers cap the preflight cache (Chromium
 * at 2 hours), so the longer max-age saves a round trip on most calls instead
 * of one every 10 minutes. The app version/build headers are allowed so web
 * analytics rows can carry them like the Android app's do.
 */
export const getCorsHeaders = (request: Request): Record<string, string> => ({
  "access-control-allow-credentials": "true",
  "access-control-allow-headers":
    "authorization, content-type, x-linkdish-app-version, x-linkdish-build-number, x-linkdish-client-id, x-linkdish-platform, x-linkdish-session-id",
  "access-control-allow-methods": "DELETE, GET, OPTIONS, PATCH, POST",
  "access-control-allow-origin": getAllowedOrigin(request),
  "access-control-max-age": "7200",
  vary: "Origin"
});

export const corsPreflight = (request: Request): Response =>
  new Response(null, {
    headers: getCorsHeaders(request),
    status: 204
  });

export const withCors = (request: Request, response: Response): Response => {
  const headers = new Headers(response.headers);

  for (const [key, value] of Object.entries(getCorsHeaders(request))) {
    headers.set(key, value);
  }

  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText
  });
};

export const corsJson = (request: Request, body: unknown, init?: ResponseInit): Response =>
  withCors(request, Response.json(body, init));
