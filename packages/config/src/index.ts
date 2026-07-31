import { z } from "zod";

export const readEnv = <TSchema extends z.ZodRawShape>(
  schemaShape: TSchema,
  input: Record<string, string | undefined>
) =>
  z
    .object(schemaShape)
    .transform((value) => value)
    .parse(input);

export const stringBooleanSchema = z.enum(["true", "false"]).transform((value) => value === "true");
