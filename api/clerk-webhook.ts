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

const errorResponse = (error: unknown): Response =>
  jsonError(
    error instanceof Error ? error.message : "Unexpected Clerk webhook error.",
    typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      typeof (error as { statusCode?: unknown }).statusCode === "number"
      ? (error as { statusCode: number }).statusCode
      : 500
  );

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
