import type { ShoppingAccount } from "../shopping/shopping-sync";

/**
 * "Add … to the shopping list" from the palette. The shopping store (and the recipe-domain
 * parsing it needs) loads only when this runs, so opening the palette stays light.
 * Returns the item text as it went on the list, or null when there was nothing to add.
 */
export const addTextToShoppingList = async (
  text: string,
  account: ShoppingAccount
): Promise<string | null> => {
  const [store, sync] = await Promise.all([
    import("../shopping/shopping-list-store"),
    import("../shopping/shopping-sync")
  ]);
  const parsed = store.parseManualShoppingLine(text);

  if (!parsed) {
    return null;
  }

  // Household lists sync: make sure the sync layer knows who is signed in.
  sync.setShoppingAccount(account);
  await store.addParsedShoppingItems([parsed], sync.getShoppingWriteOptions());
  sync.requestShoppingSync();

  return parsed.text;
};
