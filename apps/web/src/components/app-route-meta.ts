export type AppSection = "cookbook" | "plan" | "add" | "shopping" | "you";

export interface AppRouteMeta {
  /** Short title for the top app bar and document.title. */
  title: string;
  /** Top-level destinations (tab bar targets) show no back button on phones. */
  isDestination: boolean;
  /** Which primary nav item is highlighted. */
  section: AppSection | null;
  /**
   * Hides the phone tab bar so the page's own sticky actions have the room (recipe detail).
   * The desktop rail stays.
   */
  hideTabBar?: boolean | undefined;
}

const DESTINATIONS: Record<string, AppRouteMeta> = {
  "/": { title: "Cookbook", isDestination: true, section: "cookbook" },
  "/plan": { title: "Meal plan", isDestination: true, section: "plan" },
  "/import": { title: "Add a recipe", isDestination: true, section: "add" },
  "/shopping": { title: "Shopping list", isDestination: true, section: "shopping" },
  "/account": { title: "Account", isDestination: true, section: "you" }
};

const SECONDARY: Array<{ match: (pathname: string) => boolean; meta: AppRouteMeta }> = [
  {
    match: (pathname) => pathname.startsWith("/recipes/shared/"),
    meta: { title: "Shared recipe", isDestination: false, section: "cookbook", hideTabBar: true }
  },
  {
    match: (pathname) => pathname.startsWith("/recipes/"),
    meta: { title: "Recipe", isDestination: false, section: "cookbook", hideTabBar: true }
  },
  {
    match: (pathname) => pathname.startsWith("/featured/"),
    meta: { title: "Featured recipe", isDestination: false, section: "cookbook" }
  },
  {
    match: (pathname) => pathname === "/household",
    meta: { title: "Household", isDestination: false, section: "you" }
  },
  {
    match: (pathname) => pathname === "/pricing",
    meta: { title: "Plans", isDestination: false, section: "you" }
  },
  {
    match: (pathname) => pathname === "/settings",
    meta: { title: "Settings", isDestination: false, section: null }
  },
  {
    match: (pathname) => pathname === "/install",
    meta: { title: "Install LinkDish", isDestination: false, section: null }
  },
  {
    match: (pathname) => pathname === "/support",
    meta: { title: "Support", isDestination: false, section: null }
  },
  {
    match: (pathname) => pathname === "/privacy",
    meta: { title: "Privacy", isDestination: false, section: null }
  }
];

export const getAppRouteMeta = (pathname: string): AppRouteMeta => {
  const normalized = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  const destination = DESTINATIONS[normalized];

  if (destination) {
    return destination;
  }

  return (
    SECONDARY.find((entry) => entry.match(normalized))?.meta ?? {
      title: "LinkDish",
      isDestination: false,
      section: null
    }
  );
};
