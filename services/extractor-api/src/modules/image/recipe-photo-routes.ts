import { ZodError } from "zod";

import { uploadRecipePhotoRequestSchema } from "../../../../../packages/api-contracts/src/index.js";
import { getAuthenticatedUser } from "../auth/auth-service.js";

import { readRecipePhoto } from "./recipe-photo-store.js";
import { RecipePhotoError, storeRecipePhoto } from "./recipe-photos.js";

import type { FastifyInstance } from "fastify";

/*
 * Served from the image function on Vercel (api/image.ts). The bytes behind an id never change,
 * but a deleted account's pictures have to leave the CDN, so the copies there are short-lived.
 */
export const RECIPE_PHOTO_HEADERS = {
  "cache-control": "public, max-age=86400",
  "cdn-cache-control": "public, s-maxage=86400",
  "content-type": "image/webp"
} as const;

export const recipePhotoErrorStatus = (error: unknown): number | null =>
  error instanceof ZodError ? 400 : error instanceof RecipePhotoError ? error.statusCode : null;

export const registerRecipePhotoRoutes = (app: FastifyInstance) => {
  app.post("/image/photos", async (request, reply) => {
    try {
      const session = await getAuthenticatedUser(request.headers);

      if (!session) {
        return await reply.status(401).send({ message: "Sign in is required." });
      }

      const { dataUrl } = uploadRecipePhotoRequestSchema.parse(request.body);
      return await reply.status(201).send(await storeRecipePhoto(session.user.id, dataUrl));
    } catch (error) {
      const status = recipePhotoErrorStatus(error);

      if (status === null) {
        request.log.error(error);
        return reply.status(500).send({ message: "The picture couldn't be saved." });
      }

      return reply.status(status).send({
        message: error instanceof RecipePhotoError ? error.message : "Choose a JPEG, PNG or WebP."
      });
    }
  });

  app.get<{ Params: { file: string } }>("/image/photos/:file", async (request, reply) => {
    const photo = await readRecipePhoto(request.params.file);

    return photo
      ? reply.headers(RECIPE_PHOTO_HEADERS).send(photo)
      : reply.status(404).send({ message: "Picture not found." });
  });
};
