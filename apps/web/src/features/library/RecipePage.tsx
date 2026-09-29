import { recipeToPlainText } from "@linkdish/recipe-domain";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";

import { trackWebEvent } from "../../analytics/client";
import { apiClient, isExtractorApiError } from "../../api/client";
import { getFriendlyErrorMessage } from "../../api/error-message";
import { getAccountScope, useIsCurrentAccount } from "../../auth/account-scope";
import { useAuth } from "../../auth/AuthProvider";
import { AppTopBarActions } from "../../components/AppShell";
import { Button, ButtonLink } from "../../components/Button";
import { Chip } from "../../components/Chip";
import { ConfirmationDialog } from "../../components/ConfirmationDialog";
import { EmptyState } from "../../components/EmptyState";
import { ErrorState } from "../../components/ErrorState";
import { IconButton } from "../../components/IconButton";
import { LoadingState } from "../../components/LoadingState";
import { Menu } from "../../components/Menu";
import { useToast } from "../../components/Toast";
import {
  duplicateRecipe,
  logCooked,
  markOpened,
  removeSavedRecipe,
  setPreferredServings,
  setRating,
  toggleFavorite,
  updateNotes,
  useSavedRecipes
} from "../../data/library-store";
import { useLinkDishDbStatus } from "../../data/storage-status";
import { buildRecipeImageUrl } from "../../lib/recipe-image";
import { createShareCardBlob } from "../../lib/share-card";
import { useDocumentTitle } from "../../lib/use-document-title";
import { RAIL_MEDIA_QUERY, useMediaQuery } from "../../lib/use-media-query";
import { holdAutoApplyUpdate, UNDO_UPDATE_HOLD_MS } from "../../platform/app-update";
import { LazyCookMode, preloadCookMode } from "../cook-mode/LazyCookMode";
import { useRecipeMenuExtras } from "../recipe-view/recipe-menu-extras";
import { useRecipeScaling } from "../recipe-view/recipe-scaling";
import { getRecipeSourceInfo } from "../recipe-view/recipe-source";
import { RecipeActionBar } from "../recipe-view/RecipeActionBar";
import { RecipeEditorSheet } from "../recipe-view/RecipeEditorSheet";
import { RecipeView } from "../recipe-view/RecipeView";
import { useIngredientChecks } from "../recipe-view/use-ingredient-checks";
import { AddRecipeToShoppingSheet } from "../shopping/AddRecipeToShoppingSheet";
import { setShoppingAccount } from "../shopping/shopping-sync";
import { useUpgradeSheet } from "../upgrade/UpgradeSheet";

import {
  getSavedRecipeById,
  getSavedRecipeSourceImages,
  getSharedRecipeOwnerLabel,
  getSourceHost,
  LOCAL_LIMIT_FREE,
  restoreSavedRecipe,
  SavedRecipeLimitError,
  saveSharedRecipeCopy,
  sharedRecipeToWebSavedRecipe,
  syncRecipeToHousehold,
  updateSavedRecipe
} from "./saved-recipe-store";

import type { WebSavedRecipe } from "./saved-recipe-types";
import type { MenuEntry } from "../../components/Menu";
import type { RecipeEditorValues } from "../recipe-view/RecipeEditorSheet";
import type { ExtractRecipeImage, SharedRecipe } from "@linkdish/api-contracts";

import "./RecipePage.css";

const getShareCardFilename = (title: string): string => {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "")
    .slice(0, 48);

  return `${slug || "linkdish-recipe"}-share-card.png`;
};

const downloadBlob = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
};

const isAbortError = (error: unknown): boolean =>
  error instanceof Error && error.name === "AbortError";

const isNotFoundError = (error: unknown): boolean =>
  isExtractorApiError(error) && error.statusCode === 404;

/* ------------------------------------------------------------------------------------------------
 * Route
 * ---------------------------------------------------------------------------------------------- */

/** /recipes/:id (your cookbook) and /recipes/shared/:sharedId (a household recipe). */
export const RecipePage: React.FC = () => {
  const { id, sharedId } = useParams<{ id?: string; sharedId?: string }>();
  const { isAuthenticated, user } = useAuth();
  // Checked here, above the screens: a family recipe's screen goes away when another account
  // signs in, and what its requests answer afterwards must not land on that account.
  const isCurrentAccount = useIsCurrentAccount(getAccountScope(isAuthenticated, user));

  return sharedId ? (
    <SharedRecipeRoute
      isCurrentAccount={isCurrentAccount}
      key={`shared:${sharedId}`}
      sharedId={sharedId}
    />
  ) : (
    <SavedRecipeRoute isCurrentAccount={isCurrentAccount} key={`saved:${id ?? ""}`} id={id ?? ""} />
  );
};

/** Whether an account (captured when some work started) is still the one signed in. */
type IsCurrentAccount = (account: string | null) => boolean;

const RecipePageShell: React.FC<{ children: React.ReactNode; className?: string }> = ({
  children,
  className = ""
}) => {
  const dbStatus = useLinkDishDbStatus();

  return (
    <div className={`recipe-page page-enter ${className}`.trim()}>
      {dbStatus.state === "outdated" || dbStatus.state === "blocked" ? (
        <div className="recipe-page-banner print-hide" role="status">
          {dbStatus.state === "outdated"
            ? "LinkDish was updated in another tab. Reload to keep going."
            : "Close other LinkDish tabs to finish updating."}
          {dbStatus.state === "outdated" ? (
            <Button onClick={() => window.location.reload()} size="sm" variant="secondary">
              Reload
            </Button>
          ) : null}
        </div>
      ) : null}
      {children}
    </div>
  );
};

const RecipeNotFound: React.FC<{ shared?: boolean }> = ({ shared = false }) => (
  <RecipePageShell className="is-empty">
    <EmptyState
      actions={
        <ButtonLink icon="book-open" to="/" variant="primary">
          Back to your cookbook
        </ButtonLink>
      }
      body={
        shared
          ? "This family recipe was removed or is no longer shared with you."
          : "It may have been deleted, or it was saved on another device."
      }
      headingLevel={1}
      illustration="search"
      title={shared ? "Family recipe not found" : "Recipe not found"}
    />
  </RecipePageShell>
);

const SavedRecipeRoute: React.FC<{ id: string; isCurrentAccount: IsCurrentAccount }> = ({
  id,
  isCurrentAccount
}) => {
  const { recipes, retry, status } = useSavedRecipes();
  const recipe = useMemo(() => recipes.find((entry) => entry.id === id), [id, recipes]);
  const [sourceImages, setSourceImages] = useState<ExtractRecipeImage[] | undefined>();
  const openedRef = useRef<string | null>(null);
  const imageCount = recipe?.sourceImageCount ?? 0;

  // List records never carry the (large) scans; load them only for recipes that have some.
  useEffect(() => {
    if (!imageCount) {
      setSourceImages(undefined);
      return;
    }

    let cancelled = false;
    getSavedRecipeSourceImages(id).then(
      (images) => {
        if (!cancelled) {
          setSourceImages(images);
        }
      },
      (error: unknown) => console.warn("Could not load the recipe photos.", error)
    );

    return () => {
      cancelled = true;
    };
  }, [id, imageCount]);

  useEffect(() => {
    if (!recipe || openedRef.current === recipe.id) {
      return;
    }

    openedRef.current = recipe.id;
    trackWebEvent({
      eventName: "recipe_opened",
      routeOrScreen: "/recipes/:id",
      properties: { surface: "recipe_detail" }
    });
    void markOpened(recipe.id).catch(() => undefined);
  }, [recipe]);

  if (!recipe) {
    if (status === "loading") {
      return <LoadingState message="Warming up the recipe…" variant="recipe" />;
    }

    if (status === "error") {
      return (
        <RecipePageShell className="is-empty">
          <ErrorState
            headingLevel={1}
            message="Your cookbook on this device couldn’t be opened. Your recipes are still there."
            onRetry={retry}
            title="This recipe didn’t load"
          />
        </RecipePageShell>
      );
    }

    return <RecipeNotFound />;
  }

  return (
    <RecipeScreen
      isCurrentAccount={isCurrentAccount}
      kind="saved"
      record={recipe}
      sourceImages={sourceImages}
    />
  );
};

type SharedState =
  | { status: "loading" }
  | { status: "signed-out" }
  | { status: "error"; error: unknown }
  | { status: "ready"; shared: SharedRecipe | null };

const SharedRecipeRoute: React.FC<{ sharedId: string; isCurrentAccount: IsCurrentAccount }> = ({
  sharedId,
  isCurrentAccount
}) => {
  const { credentialsKey, isAuthenticated, loading: authLoading } = useAuth();
  const [loaded, setLoaded] = useState<{ key: string | null; state: SharedState }>({
    key: null,
    state: { status: "loading" }
  });
  const setState = useCallback(
    (next: SharedState) => setLoaded({ key: credentialsKey, state: next }),
    [credentialsKey]
  );
  // A signed-in account only ever sees the answer to its own credentials' request.
  const state: SharedState =
    loaded.key === credentialsKey || loaded.state.status === "signed-out"
      ? loaded.state
      : { status: "loading" };
  /** An owner's edit, kept only while what's shown is still the answer for these credentials. */
  const applyEdit = useCallback(
    (next: SharedRecipe) =>
      setLoaded((current) =>
        current.key === credentialsKey
          ? { key: credentialsKey, state: { shared: next, status: "ready" } }
          : current
      ),
    [credentialsKey]
  );
  const [reloadToken, setReloadToken] = useState(0);
  const openedRef = useRef(false);

  // Keyed on the credentials: waits for a cached Clerk user's session (instead of a 401) and
  // loads again once Clerk signs in.
  useEffect(() => {
    if (authLoading) {
      return;
    }

    if (!isAuthenticated) {
      setState({ status: "signed-out" });
      return;
    }

    if (credentialsKey === null) {
      return;
    }

    // Ignore a slow response for a recipe we already navigated away from.
    let cancelled = false;
    setState({ status: "loading" });
    apiClient.getSharedRecipes().then(
      (response) => {
        if (!cancelled) {
          setState({
            shared: response.recipes.find((entry) => entry.id === sharedId) ?? null,
            status: "ready"
          });
        }
      },
      (error: unknown) => {
        if (!cancelled) {
          setState({ error, status: "error" });
        }
      }
    );

    return () => {
      cancelled = true;
    };
  }, [authLoading, credentialsKey, isAuthenticated, reloadToken, setState, sharedId]);

  const shared = state.status === "ready" ? state.shared : null;

  useEffect(() => {
    if (!shared || openedRef.current) {
      return;
    }

    openedRef.current = true;
    trackWebEvent({
      eventName: "recipe_opened",
      routeOrScreen: "/recipes/shared/:id",
      properties: { surface: "shared_link" }
    });
  }, [shared]);

  if (state.status === "loading") {
    return <LoadingState message="Fetching the family recipe…" variant="recipe" />;
  }

  if (state.status === "signed-out") {
    return (
      <RecipePageShell className="is-empty">
        <EmptyState
          actions={
            <ButtonLink icon="log-in" to="/account" variant="primary">
              Sign in
            </ButtonLink>
          }
          body="Family recipes live in your household. Sign in to open this one."
          headingLevel={1}
          illustration="cookbook"
          title="Sign in to see this recipe"
        />
      </RecipePageShell>
    );
  }

  if (state.status === "error") {
    return (
      <RecipePageShell className="is-empty">
        <ErrorState
          headingLevel={1}
          message={getFriendlyErrorMessage(state.error, "household")}
          onRetry={() => setReloadToken((token) => token + 1)}
          title="This family recipe didn’t load"
        />
      </RecipePageShell>
    );
  }

  if (!state.shared) {
    return <RecipeNotFound shared />;
  }

  return (
    <RecipeScreen
      isCurrentAccount={isCurrentAccount}
      kind="shared"
      onSharedChange={applyEdit}
      record={sharedRecipeToWebSavedRecipe(state.shared)}
      shared={state.shared}
    />
  );
};

/* ------------------------------------------------------------------------------------------------
 * Screen
 * ---------------------------------------------------------------------------------------------- */

type RecipeScreenProps = { isCurrentAccount: IsCurrentAccount } & (
  | { kind: "saved"; record: WebSavedRecipe; sourceImages?: ExtractRecipeImage[] | undefined }
  | {
      kind: "shared";
      record: WebSavedRecipe;
      shared: SharedRecipe;
      onSharedChange: (shared: SharedRecipe) => void;
    }
);

const RecipeScreen: React.FC<RecipeScreenProps> = (props) => {
  const { record } = props;
  const recipe = record.recipe;
  const isSaved = props.kind === "saved";
  const shared = props.kind === "shared" ? props.shared : null;
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { credentialsKey, isAuthenticated, loading: authLoading, user } = useAuth();
  const { isCurrentAccount } = props;
  /** Who is signed in for this render: household answers and actions belong to them. */
  const account = getAccountScope(isAuthenticated, user);
  const { requestUpgradeSheet } = useUpgradeSheet();
  const { showToast } = useToast();
  const isDesktop = useMediaQuery(RAIL_MEDIA_QUERY);
  const menuExtras = useRecipeMenuExtras(isSaved ? record : null);
  const [cookOpen, setCookOpen] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  /**
   * The open shopping sheet, with the account it was opened for. `canSync` is undefined when the
   * household check could not answer: the sheet then uses the cached mode.
   */
  const [shopping, setShopping] = useState<{
    account: string | null;
    canSync: boolean | undefined;
  } | null>(null);
  /** The open delete or unshare confirmation, with the account it was opened for. */
  const [confirmAsk, setConfirmAsk] = useState<{
    account: string | null;
    kind: "delete-synced" | "unshare";
  } | null>(null);
  const [busy, setBusy] = useState<"delete" | "duplicate" | "sync" | "share-card" | null>(null);
  // The sheet goes by its account's household: another account signing in or out never sees it,
  // not even for a render (this screen stays up for a cookbook recipe), and it is closed for good.
  const shoppingSheet = shopping?.account === account ? shopping : null;
  // Likewise a confirmation: removing the household copy was that account's.
  const confirm = confirmAsk?.account === account ? confirmAsk.kind : null;
  const setConfirm = useCallback(
    (kind: "delete-synced" | "unshare" | null) => setConfirmAsk(kind ? { account, kind } : null),
    [account]
  );

  useEffect(() => {
    setShopping((current) => (current && current.account !== account ? null : current));
    setConfirmAsk((current) => (current && current.account !== account ? null : current));
  }, [account]);

  useDocumentTitle(recipe.title);

  const isPremiumUser = user?.billingPlan === "plus" || user?.billingPlan === "family";
  const isOwner = shared ? shared.ownerUserId === user?.id : true;
  const canEdit = isSaved || isOwner;
  const sessionKey = isSaved ? record.id : `shared:${shared?.id ?? record.id}`;
  const recipeHref = isSaved ? `/recipes/${record.id}` : `/recipes/shared/${shared?.id ?? ""}`;
  const source = useMemo(
    () =>
      getRecipeSourceInfo(record.sourceUrl, {
        isStarter: record.isStarter,
        sourceHost: record.sourceHost || getSourceHost(record.sourceUrl)
      }),
    [record.isStarter, record.sourceHost, record.sourceUrl]
  );
  const recordId = record.id;
  const handlePreferredServings = useCallback(
    (servings: number | null) => {
      void setPreferredServings(recordId, servings).catch(() => undefined);
    },
    [recordId]
  );
  const scaling = useRecipeScaling(
    recipe,
    isSaved
      ? {
          onPreferredServingsChange: handlePreferredServings,
          preferredServings: record.preferredServings
        }
      : {}
  );
  const checks = useIngredientChecks(sessionKey);
  const timerContext = useMemo(
    () => ({ href: recipeHref, recipeTitle: recipe.title, sessionKey }),
    [recipe.title, recipeHref, sessionKey]
  );
  const canSync =
    isSaved && isAuthenticated && !record.isStarter && record.sync?.status !== "synced";

  // Library "Duplicate" links here with ?edit=1 so the copy opens straight in the editor.
  useEffect(() => {
    if (searchParams.get("edit") !== "1") {
      return;
    }

    if (canEdit) {
      setEditorOpen(true);
    }

    const next = new URLSearchParams(searchParams);
    next.delete("edit");
    setSearchParams(next, { replace: true });
  }, [canEdit, searchParams, setSearchParams]);

  // The command palette's "Start cooking" links here with ?cook=1.
  useEffect(() => {
    if (searchParams.get("cook") !== "1") {
      return;
    }

    setCookOpen(true);
    const next = new URLSearchParams(searchParams);
    next.delete("cook");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  /* ----------------------------------- actions ----------------------------------- */

  const openShoppingSheet = useCallback(async () => {
    const askedFor = account;
    // Offline (or when the check fails) a household member's items must still be marked for the
    // household list: the sheet then falls back to the shopping sync layer's (cached) mode.
    let canSyncItems: boolean | undefined = isAuthenticated ? undefined : false;
    setShoppingAccount({ credentialsKey, isAuthenticated, loading: authLoading, userId: user?.id });

    if (isAuthenticated) {
      try {
        const householdResponse = await apiClient.getHousehold();
        canSyncItems = Boolean(householdResponse.household);
      } catch {
        // Unknown: leave it to the sync layer.
      }
    }

    // Another account signed in while the household was checked: the answer, and the sheet it
    // was for, belonged to the last one.
    if (!isCurrentAccount(askedFor)) {
      return;
    }

    setShopping({ account: askedFor, canSync: canSyncItems });
  }, [account, authLoading, credentialsKey, isAuthenticated, isCurrentAccount, user?.id]);

  const handleShare = async () => {
    const title = recipe.title;
    const exportOptions = { scale: scaling.state.factor, units: scaling.units };

    if (typeof navigator.share === "function") {
      try {
        await navigator.share({
          text: recipeToPlainText(recipe, { ...exportOptions, includeSource: false }),
          title,
          ...(source.shareUrl ? { url: source.shareUrl } : {})
        });
        return;
      } catch (error) {
        if (isAbortError(error)) {
          return;
        }
      }
    }

    try {
      await navigator.clipboard.writeText(
        recipeToPlainText(recipe, { ...exportOptions, includeSource: Boolean(source.shareUrl) })
      );
      showToast({ icon: "copy", message: "Recipe copied. Paste it anywhere." });
    } catch {
      showToast({ message: "Sharing isn’t available in this browser.", tone: "danger" });
    }
  };

  const handleShareCard = async () => {
    setBusy("share-card");

    try {
      const blob = await createShareCardBlob({
        imageUrl: buildRecipeImageUrl(recipe.image, 1200),
        sourceHost: source.kind === "web" ? source.label : null,
        sourceUrl: source.shareUrl,
        title: recipe.title
      });
      const file = new File([blob], getShareCardFilename(recipe.title), { type: "image/png" });

      if (navigator.share && navigator.canShare?.({ files: [file] })) {
        try {
          await navigator.share({
            files: [file],
            text: `Get cooking with ${recipe.title}.`,
            title: recipe.title
          });
          return;
        } catch (error) {
          if (isAbortError(error)) {
            return;
          }
        }
      }

      downloadBlob(blob, file.name);
      showToast({ icon: "download", message: "Share card downloaded." });
    } catch (error) {
      console.error("Share card failed:", error);
      showToast({ message: "The share card couldn’t be made. Please try again.", tone: "danger" });
    } finally {
      setBusy(null);
    }
  };

  const handleDuplicate = async () => {
    setBusy("duplicate");

    try {
      const copy = shared
        ? await saveSharedRecipeCopy(shared, { isPremiumUser })
        : await duplicateRecipe(record.id, { isPremiumUser });

      if (!copy) {
        showToast({ message: "This recipe is no longer available to copy.", tone: "danger" });
        return;
      }

      showToast({
        icon: "check-circle",
        message: shared ? "Saved to your cookbook." : "Copy made. Tweak away!",
        tone: "success"
      });
      void navigate(`/recipes/${copy.id}`);
    } catch (error) {
      if (error instanceof SavedRecipeLimitError) {
        requestUpgradeSheet("save_limit");
        showToast({
          message: "Your free cookbook is full. Upgrade for unlimited recipes.",
          tone: "danger"
        });
        return;
      }

      console.error("Duplicate failed:", error);
      showToast({ message: getFriendlyErrorMessage(error, "save"), tone: "danger" });
    } finally {
      setBusy(null);
    }
  };

  const handleSync = async () => {
    if (!isSaved || !isAuthenticated) {
      return;
    }

    const syncedFor = account;
    // Toast actions ("Sync now" after an edit, "Retry") keep the render they were created in, so
    // decide from the recipe as stored now rather than this render's `record` and `canSync`.
    const latest = await getSavedRecipeById(record.id).catch(() => undefined);

    if (!latest || latest.isStarter || latest.sync?.status === "synced") {
      return;
    }

    setBusy("sync");
    const wasAlreadyShared = Boolean(latest.sync?.sharedRecipeId);

    try {
      const synced = await syncRecipeToHousehold(latest, {
        isCurrent: () => isCurrentAccount(syncedFor)
      });

      // Another account signed in (or out) meanwhile: the share stopped before sharing into its
      // household, and its toast, or an upsell, was the last account's.
      if (!isCurrentAccount(syncedFor)) {
        return;
      }

      if (synced.sync?.status === "synced") {
        if (!wasAlreadyShared) {
          trackWebEvent({
            eventName: "family_shared",
            routeOrScreen: "/recipes/:id",
            properties: { recipe_count: 1, share_scope: "household" }
          });
        }

        showToast({ icon: "check-circle", message: "Synced to your household.", tone: "success" });
      } else if (synced.sync?.status === "local_only") {
        if (user?.billingPlan === "family") {
          showToast({
            action: { label: "Set up", onClick: () => void navigate("/household") },
            message: "Create your household first, then sync recipes to it."
          });
        } else {
          requestUpgradeSheet("family_share_no_plan");
        }
      } else {
        showToast({
          action: { label: "Retry", onClick: () => void handleSync() },
          message: "This recipe couldn’t sync. Check your connection and try again.",
          tone: "danger"
        });
      }
    } catch (error) {
      if (isCurrentAccount(syncedFor)) {
        showToast({ message: getFriendlyErrorMessage(error, "sync"), tone: "danger" });
      }
    } finally {
      setBusy(null);
    }
  };

  const deleteLocalWithUndo = async () => {
    const title = recipe.title;
    // The full copy (with photos) the delete removed, so Undo restores exactly that.
    const snapshot = (await removeSavedRecipe(record.id)) ?? record;
    // Undo lives in memory: a waiting app update must not reload the page on this navigation.
    holdAutoApplyUpdate(UNDO_UPDATE_HOLD_MS);
    void navigate("/");
    showToast({
      action: {
        label: "Undo",
        onClick: () => {
          void restoreSavedRecipe(snapshot, { isPremiumUser }).then(
            ({ recipe: current, restored }) =>
              showToast({
                // Saved again (say, in another tab) since the delete: that newer copy stays.
                message: restored
                  ? `“${title}” is back in your cookbook.`
                  : `“${current.recipe.title}” is already back in your cookbook.`
              }),
            (error: unknown) =>
              showToast(
                error instanceof SavedRecipeLimitError
                  ? {
                      // The cookbook filled up again since the delete: it stays deleted.
                      action: {
                        label: "Upgrade",
                        onClick: () => {
                          if (!requestUpgradeSheet("save_limit")) {
                            void navigate("/pricing?upgrade=plus");
                          }
                        }
                      },
                      icon: "lock",
                      message: `Your cookbook is full, so “${title}” stays deleted. Free cookbooks hold ${LOCAL_LIMIT_FREE} recipes.`
                    }
                  : { message: "That recipe couldn’t be restored.", tone: "danger" }
              )
          );
        }
      },
      icon: "trash",
      message: `Deleted “${title}”.`
    });
  };

  const handleDelete = async () => {
    const deletingFor = account;
    const householdCopy =
      shared != null || (isAuthenticated && Boolean(record.sync?.sharedRecipeId));
    setBusy("delete");

    try {
      if (shared) {
        await apiClient.deleteSharedRecipe(shared.id);

        // Another account signed in meanwhile: the family recipe (and its toast) was the last one's.
        if (!isCurrentAccount(deletingFor)) {
          return;
        }

        setConfirm(null);
        showToast({ message: `“${recipe.title}” is no longer shared.` });
        void navigate("/");
        return;
      }

      const sharedRecipeId = record.sync?.sharedRecipeId;

      if (isAuthenticated && sharedRecipeId) {
        // Like the cookbook: remove the household copy first so it isn't left orphaned.
        try {
          await apiClient.deleteSharedRecipe(sharedRecipeId);
        } catch (error) {
          if (!isNotFoundError(error)) {
            throw error;
          }
        }

        // Another account signed in (or out) meanwhile: the request may have gone out as it, and
        // its household never had this recipe (not found), so the household copy may still be
        // there. The recipe stays on this device until its household copy is known to be gone.
        if (!isCurrentAccount(deletingFor)) {
          return;
        }

        // No Undo here (the household copy is already gone), so nothing to read back.
        await removeSavedRecipe(record.id, { snapshot: false });
        setConfirm(null);
        showToast({ message: `Deleted “${recipe.title}” here and from your household.` });
        void navigate("/");
        return;
      }

      await deleteLocalWithUndo();
    } catch (error) {
      console.error("Delete failed:", error);

      if (householdCopy && !isCurrentAccount(deletingFor)) {
        return;
      }

      setConfirm(null);
      showToast({
        message: getFriendlyErrorMessage(
          error,
          shared || record.sync?.sharedRecipeId ? "household" : "generic"
        ),
        tone: "danger"
      });
    } finally {
      setBusy(null);
    }
  };

  const requestDelete = () => {
    if (shared) {
      setConfirm("unshare");
    } else if (isAuthenticated && record.sync?.sharedRecipeId) {
      setConfirm("delete-synced");
    } else {
      void handleDelete();
    }
  };

  const handleSaveEdits = async (values: RecipeEditorValues) => {
    if (shared && props.kind === "shared") {
      const editedFor = account;
      const response = await apiClient.updateSharedRecipe(shared.id, {
        notes: values.notes,
        recipe: values.recipe
      });

      // Another account signed in meanwhile: the edited recipe is the last one's household's.
      if (!isCurrentAccount(editedFor)) {
        return;
      }

      props.onSharedChange(response.recipe);
      showToast({ icon: "check-circle", message: "Family recipe updated.", tone: "success" });
      return;
    }

    // One write of only what was changed in the editor (and the link), so a note, edit, cook or
    // favorite saved meanwhile, here or in another tab, is kept.
    const updated = await updateSavedRecipe(record.id, {
      ...values.changes,
      ...(values.sourceUrl ? { sourceUrl: values.sourceUrl } : {})
    });

    if (!updated) {
      throw new Error("This saved recipe is no longer available.");
    }

    // A save that changed nothing leaves a synced recipe synced: there is nothing to sync then.
    if (updated.sync?.sharedRecipeId && updated.sync.status !== "synced" && isAuthenticated) {
      showToast({
        action: { label: "Sync now", onClick: () => void handleSync() },
        message: "Saved here. Sync to update your household’s copy."
      });
    } else {
      showToast({ icon: "check-circle", message: "Recipe updated.", tone: "success" });
    }
  };

  const handleToggleFavorite = () => {
    void toggleFavorite(record.id).catch(() =>
      showToast({ message: "That didn’t save. Please try again.", tone: "danger" })
    );
  };

  /* ------------------------------------- menu ------------------------------------ */

  // Grouped so the long menu scans at a glance: organise, share, edit, then Delete on its own.
  const menuItems: MenuEntry[] = [
    ...(menuExtras.items.length > 0
      ? [
          { id: "group-organise", label: "Plan & organise", type: "separator" as const },
          ...menuExtras.items
        ]
      : []),
    { id: "group-share", label: "Share & print", type: "separator" },
    { icon: "share-up", id: "share", label: "Share", onSelect: () => void handleShare() },
    {
      description: "A picture to post or send",
      disabled: busy === "share-card",
      icon: "image",
      id: "share-card",
      label: "Share card",
      onSelect: () => void handleShareCard()
    },
    { icon: "printer", id: "print", label: "Print", onSelect: () => window.print() },
    ...(canSync
      ? [
          {
            disabled: busy === "sync",
            icon: "cloud-upload" as const,
            id: "sync",
            label:
              record.sync?.status === "dirty" || record.sync?.status === "sync_failed"
                ? "Sync changes to household"
                : "Share with household",
            onSelect: () => void handleSync()
          }
        ]
      : []),
    // Without edit rights the group only holds "Save a copy", so it goes unnamed.
    { id: "group-edit", label: canEdit ? "Edit" : undefined, type: "separator" },
    ...(canEdit
      ? [
          {
            icon: "pencil" as const,
            id: "edit",
            label: "Edit recipe",
            onSelect: () => setEditorOpen(true)
          }
        ]
      : []),
    shared
      ? {
          disabled: busy === "duplicate",
          icon: "bookmark-plus" as const,
          id: "copy",
          label: "Save a copy",
          onSelect: () => void handleDuplicate()
        }
      : {
          disabled: busy === "duplicate",
          icon: "copy" as const,
          id: "duplicate",
          label: "Duplicate",
          onSelect: () => void handleDuplicate()
        },
    ...(canEdit
      ? [
          { id: "danger-separator", type: "separator" as const },
          {
            disabled: busy === "delete",
            icon: "trash" as const,
            id: "delete",
            label: shared ? "Unshare from household" : "Delete recipe",
            onSelect: requestDelete,
            tone: "danger" as const
          }
        ]
      : [])
  ];

  const moreMenu = (
    <Menu
      items={menuItems}
      label="Recipe actions"
      presentation="adaptive"
      renderTrigger={(triggerProps) => (
        <IconButton
          {...triggerProps}
          aria-label="More actions"
          icon="more-horizontal"
          variant={isDesktop ? "ghost" : "tonal"}
        />
      )}
      sheetTitle={recipe.title}
    />
  );

  const favoriteButton = isSaved ? (
    <IconButton
      aria-label={record.favorite ? "Remove from favorites" : "Add to favorites"}
      className="recipe-favorite-button"
      icon="heart"
      onClick={handleToggleFavorite}
      pressed={Boolean(record.favorite)}
      pressedIcon="heart-filled"
      variant={isDesktop ? "ghost" : "tonal"}
    />
  ) : (
    <IconButton
      aria-label="Save a copy to my cookbook"
      disabled={busy === "duplicate"}
      icon="bookmark-plus"
      onClick={() => void handleDuplicate()}
      variant={isDesktop ? "ghost" : "tonal"}
    />
  );

  const startCookingButton = (
    <Button
      className="recipe-start-cooking"
      icon="chef-hat"
      onClick={() => setCookOpen(true)}
      onFocus={preloadCookMode}
      onPointerEnter={preloadCookMode}
      size="lg"
      variant="primary"
    >
      Start cooking
    </Button>
  );

  // A starter needs no chip of its own: the source chip beside these already says "LinkDish
  // kitchen". Sync labels match the Cookbook cards'.
  const statusChips = (
    <>
      {shared ? (
        <Chip icon="users" size="sm" variant="accent">
          Shared by {getSharedRecipeOwnerLabel(shared)}
        </Chip>
      ) : record.sync?.status === "synced" ? (
        <Chip icon="check" size="sm" variant="accent">
          Synced
        </Chip>
      ) : record.sync?.status === "dirty" ? (
        <Chip icon="refresh" size="sm" variant="butter">
          Edits not shared
        </Chip>
      ) : record.sync?.status === "sync_failed" ? (
        <Chip size="sm" variant="tomato">
          Sync failed
        </Chip>
      ) : null}
    </>
  );

  return (
    <RecipePageShell className={isDesktop ? "is-desktop" : "has-action-bar"}>
      {isDesktop ? (
        <AppTopBarActions>
          {favoriteButton}
          <IconButton aria-label="Share" icon="share-up" onClick={() => void handleShare()} />
          {moreMenu}
        </AppTopBarActions>
      ) : null}

      <RecipeView
        checks={checks}
        heroActions={
          isDesktop ? (
            <>
              {startCookingButton}
              <Button
                icon="shopping-basket"
                onClick={() => void openShoppingSheet()}
                size="lg"
                variant="secondary"
              >
                Add to shopping list
              </Button>
            </>
          ) : undefined
        }
        heroEyebrow={statusChips}
        lastCookedAt={record.lastCookedAt}
        notes={record.notes}
        onRate={
          isSaved ? (value) => void setRating(record.id, value).catch(() => undefined) : undefined
        }
        onSaveNotes={
          isSaved ? (notes) => updateNotes(record.id, notes).then(() => undefined) : undefined
        }
        rating={record.rating}
        recipe={recipe}
        scaling={scaling}
        source={source}
        sourceImages={isSaved && props.kind === "saved" ? props.sourceImages : undefined}
        tags={record.tags}
        timerContext={timerContext}
        timesCooked={record.timesCooked}
        warnings={record.extraction.warnings}
      />

      {!isDesktop ? (
        <RecipeActionBar>
          {startCookingButton}
          <IconButton
            aria-label="Add to shopping list"
            icon="shopping-basket"
            onClick={() => void openShoppingSheet()}
            size="lg"
            variant="tonal"
          />
          {favoriteButton}
          {moreMenu}
        </RecipeActionBar>
      ) : null}

      <LazyCookMode
        onAddIngredientsToShoppingList={openShoppingSheet}
        onClose={() => setCookOpen(false)}
        onLogCook={
          isSaved
            ? async ({ note }) => {
                await logCooked(record.id, note ? { note } : {});
              }
            : undefined
        }
        onRate={
          isSaved ? (value) => void setRating(record.id, value).catch(() => undefined) : undefined
        }
        open={cookOpen}
        rating={record.rating}
        recipe={recipe}
        recipeHref={recipeHref}
        scaling={scaling}
        sessionKey={sessionKey}
      />

      {canEdit ? (
        <RecipeEditorSheet
          notes={record.notes}
          onClose={() => setEditorOpen(false)}
          onSave={handleSaveEdits}
          open={editorOpen}
          recipe={recipe}
          sourceUrl={isSaved && source.kind === "web" ? record.sourceUrl : null}
          title={shared ? "Edit family recipe" : "Edit recipe"}
        />
      ) : null}

      {shoppingSheet ? (
        <AddRecipeToShoppingSheet
          canSync={shoppingSheet.canSync}
          onClose={() => setShopping(null)}
          recipe={recipe}
          recipeId={shared ? shared.id : record.id}
          scaling={scaling.state}
          userId={user?.id}
        />
      ) : null}

      {menuExtras.elements}

      <ConfirmationDialog
        cancelLabel={confirm === "unshare" ? "Keep shared" : "Keep recipe"}
        confirmLabel={confirm === "unshare" ? "Unshare" : "Delete"}
        confirmLoading={busy === "delete"}
        message={
          confirm === "unshare"
            ? `Remove “${recipe.title}” from your Family recipe book?`
            : `“${recipe.title}” will be deleted from this device and from your household.`
        }
        onCancel={() => setConfirm(null)}
        onConfirm={() => void handleDelete()}
        title={confirm === "unshare" ? "Unshare recipe?" : "Delete recipe?"}
        visible={confirm != null}
      />
    </RecipePageShell>
  );
};
