import { handleClerkWebhook } from "../services/extractor-api/src/modules/auth/clerk-webhook-service.js";

export const config = {
  maxDuration: 30
};

const jsonError = (message: string, status: number): Response =>
  Response.json(
    {
      message
    },
    {
      status
    }
  );

/* null means the error carried no status of its own, i.e. it is unclassified. */
const getClassifiedErrorStatus = (error: unknown): number | null =>
  typeof error === "object" &&
  error !== null &&
  "statusCode" in error &&
  typeof (error as { statusCode?: unknown }).statusCode === "number"
    ? (error as { statusCode: number }).statusCode
    : null;

/* Unclassified failures can carry database or provider internals, so they are logged, not echoed. */
const errorResponse = (error: unknown): Response => {
  const status = getClassifiedErrorStatus(error);

  if (status === null) {
    console.error("Unhandled Clerk webhook error.", error);

    return jsonError("Unexpected Clerk webhook error.", 500);
  }

  return jsonError(
    error instanceof Error ? error.message : "Unexpected Clerk webhook error.",
    status
  );
};

export async function POST(request: Request) {
  try {
    return Response.json(
      await handleClerkWebhook({
        headers: request.headers,
        rawBody: await request.text()
      })
    );
  } catch (error) {
    return errorResponse(error);
  }
}
