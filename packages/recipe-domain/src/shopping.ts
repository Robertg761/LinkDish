import { z } from "zod";

export const MAX_SHOPPING_ITEM_TEXT_LENGTH = 200;

export const shoppingQuantityRangeSchema = z
  .object({
    min: z.number().finite().positive(),
    max: z.number().finite().positive()
  })
  .refine((range) => range.min <= range.max, {
    message: "Shopping item quantity range min must be less than or equal to max."
  });

export const shoppingQuantitySchema = z.union([
  z.number().finite().positive(),
  shoppingQuantityRangeSchema
]);

export const shoppingItemSchema = z.object({
  id: z.string().trim().min(1).max(120),
  text: z.string().trim().min(1).max(MAX_SHOPPING_ITEM_TEXT_LENGTH),
  qty: shoppingQuantitySchema.nullable().optional(),
  unit: z.string().trim().min(1).max(40).nullable().optional(),
  recipeId: z.string().trim().min(1).max(180).nullable().optional(),
  recipeTitle: z.string().trim().min(1).max(200).nullable().optional(),
  section: z.string().trim().min(1).max(120).nullable().optional(),
  addedBy: z.string().trim().min(1),
  checked: z.boolean(),
  checkedBy: z.string().trim().min(1).nullable().optional(),
  updatedAt: z.string().datetime()
});

export type ShoppingQuantityRange = z.infer<typeof shoppingQuantityRangeSchema>;
export type ShoppingQuantity = z.infer<typeof shoppingQuantitySchema>;
export type ShoppingItem = z.infer<typeof shoppingItemSchema>;
