import { MaterialCommunityIcons } from "@expo/vector-icons";
import { AppButton, AppSurface, AppText } from "@linkdish/ui";
import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import {
  AccessibilityInfo,
  ActivityIndicator,
  Animated,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
  useWindowDimensions
} from "react-native";
import Reanimated, {
  Easing as ReanimatedEasing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming
} from "react-native-reanimated";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { captureRef } from "react-native-view-shot";

import { trackMobileEvent } from "../src/analytics/client";
import { AppDialog } from "../src/components/AppDialog";
import { useAccount } from "../src/features/account/AccountContext";
import { useOptionalUpgradeMoment } from "../src/features/billing/UpgradeMomentContext";
import { triggerRecipeBookBounce } from "../src/features/navigation/recipeBookBounceEvents";
import { requestRecipeUrlReset } from "../src/features/recipe-intake/intakeResetEvents";
import { consumePendingImageImport } from "../src/features/recipe-intake/pendingImageImports";
import {
  RecipeResultCard,
  type RecipeShoppingActionContext
} from "../src/features/recipe-results/components/RecipeResultCard";
import { useRecipeExtraction } from "../src/features/recipe-results/hooks/useRecipeExtraction";
import { useSavedRecipes } from "../src/features/saved-recipes/SavedRecipesContext";
import {
  getSharedRecipeOwnerLabel,
  sharedRecipeToSavedRecipeRecord
} from "../src/features/saved-recipes/store";
import { ShareCard } from "../src/features/share/ShareCard";
import { shareRecipeCardImage } from "../src/features/share/shareRecipeCard";
import { AddRecipeIngredientsSheet } from "../src/features/shopping/AddRecipeIngredientsSheet";
import { useSmoothKeyboardInset } from "../src/hooks/useSmoothKeyboardInset";
import { success, warn } from "../src/lib/haptics";
import { EXTRACTION_ERROR_LINES, selectFlavorCopyLine } from "../src/theme/flavorCopy";
import { pressedOpacity, pressedScale } from "../src/theme/interactions";
import { appColors } from "../src/theme/tokens";

import type { Recipe } from "@linkdish/recipe-domain";

export const EXTRACTION_LOADING_COPY = [
  "Warming up the oven…",
  "Skimming off the ads…",
  "Chopping it down to the good stuff…",
  "Tasting for seasoning…",
  "Plating your recipe…"
] as const;

const EXTRACTION_COPY_INTERVAL_MS = 1800;
const EXTRACTION_COPY_SWAP_MS = 250;
const SAVE_TOSS_DURATION_MS = 350;

const truncateShoppingRecipeId = (value: string): string =>
  value.length <= 180 ? value : `recipe:${value.slice(0, 173)}`;

const splitEditableLines = (value: string): string[] =>
  value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);

const splitEditableIngredients = (
  value: string
): Array<{ section?: string | undefined; text: string }> => {
  let currentSection: string | undefined;
  const ingredients: Array<{ section?: string | undefined; text: string }> = [];

  for (const line of splitEditableLines(value)) {
    const heading = line.match(/^#?\s*([^:#][^:]{0,80}):$/u)?.[1]?.trim();

    if (heading) {
      currentSection = heading;
      continue;
    }

    ingredients.push({
      ...(currentSection ? { section: currentSection } : {}),
      text: line
    });
  }

  return ingredients;
};

const formatEditableIngredients = (ingredients: Recipe["ingredients"]): string => {
  const lines: string[] = [];
  let currentSection: string | null | undefined;

  for (const ingredient of ingredients) {
    const section = ingredient.section?.trim();

    if (section && section !== currentSection) {
      if (lines.length > 0) {
        lines.push("");
      }

      lines.push(`${section}:`);
      currentSection = section;
    } else if (!section) {
      currentSection = null;
    }

    lines.push(ingredient.text);
  }

  return lines.join("\n");
};

const getSourceLabel = (sourceUrl: string | undefined) => {
  if (!sourceUrl) {
    return "No source provided";
  }

  if (sourceUrl.includes("linkdish.app/image-imports/")) {
    return "Scanned image";
  }

  try {
    return new URL(sourceUrl).hostname.replace(/^www\./u, "");
  } catch {
    return sourceUrl;
  }
};

export default function RecipeScreen() {
  const { edit, imageImportId, savedId, sharedId, url } = useLocalSearchParams<{
    edit?: string;
    imageImportId?: string;
    savedId?: string;
    sharedId?: string;
    url?: string;
  }>();
  const { user } = useAccount();
  const {
    canUseSharedRecipeBook,
    cloneRecipe,
    cloneSharedRecipe,
    deleteSharedRecipe,
    getSaveLimitStatus,
    getSavedRecipeById,
    getSavedRecipeBySourceUrl,
    getSharedRecipeById,
    hasLoadedSavedRecipes,
    hasLoadedSharedRecipes,
    incrementRecipeTimesCooked,
    refreshSharedRecipes,
    removeRecipe,
    saveRecipe,
    saveRecipeToTargets,
    shareRecipe,
    unshareRecipe,
    updateSharedRecipe,
    updateRecipe
  } = useSavedRecipes();
  const { showUpgradeMoment } = useOptionalUpgradeMoment();
  const insets = useSafeAreaInsets();
  const { width: windowWidth } = useWindowDimensions();
  const [saveLimitMessage, setSaveLimitMessage] = useState<string | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [isEditorVisible, setIsEditorVisible] = useState(false);
  const [isEditorSaving, setIsEditorSaving] = useState(false);
  const [isShareCardSharing, setIsShareCardSharing] = useState(false);
  const [isSaveTargetModalVisible, setIsSaveTargetModalVisible] = useState(false);
  const [removeRecipeConfirmation, setRemoveRecipeConfirmation] = useState<{
    message: string;
    onConfirm: () => void;
    title: string;
  } | null>(null);
  const [isSaveTargetSaving, setIsSaveTargetSaving] = useState(false);
  const [isSaveTossVisible, setIsSaveTossVisible] = useState(false);
  const [saveTossKey, setSaveTossKey] = useState(0);
  const [isSourceImageViewerVisible, setIsSourceImageViewerVisible] = useState(false);
  const [shoppingSheetConfig, setShoppingSheetConfig] =
    useState<RecipeShoppingActionContext | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftServings, setDraftServings] = useState("");
  const [draftIngredients, setDraftIngredients] = useState("");
  const [draftSteps, setDraftSteps] = useState<string[]>([]);
  const [draftNotes, setDraftNotes] = useState("");
  const shareCardRef = useRef<View>(null);
  const extractionErrorTitle = useMemo(() => selectFlavorCopyLine(EXTRACTION_ERROR_LINES), []);
  const routeSavedRecipe = savedId
    ? getSavedRecipeById(savedId)
    : url
      ? getSavedRecipeBySourceUrl(url)
      : undefined;
  const routeSharedRecipe = sharedId ? getSharedRecipeById(sharedId) : undefined;
  const routeSharedRecipeRecord = useMemo(
    () => (routeSharedRecipe ? sharedRecipeToSavedRecipeRecord(routeSharedRecipe) : undefined),
    [routeSharedRecipe]
  );
  const consumedImageImportIdRef = useRef<string | undefined>(undefined);
  const [consumedImageImport, setConsumedImageImport] =
    useState<ReturnType<typeof consumePendingImageImport>>();

  useEffect(() => {
    if (consumedImageImportIdRef.current === imageImportId) {
      return;
    }

    consumedImageImportIdRef.current = imageImportId;
    setConsumedImageImport(imageImportId ? consumePendingImageImport(imageImportId) : undefined);
  }, [imageImportId]);

  const extractionSource = useMemo(() => {
    if (savedId || sharedId) {
      return undefined;
    }

    if (imageImportId) {
      if (!consumedImageImport) {
        return undefined;
      }

      return {
        images: consumedImageImport.images,
        sourceUrl: consumedImageImport.sourceUrl,
        attempt: "fallback" as const
      };
    }

    return url;
  }, [consumedImageImport, imageImportId, savedId, sharedId, url]);
  const extraction = useRecipeExtraction(
    extractionSource,
    routeSharedRecipeRecord ?? routeSavedRecipe
  );
  const currentRecipeSourceUrl =
    extraction.state.state === "success" ? extraction.state.recipe.sourceUrl : url;
  const hasRequestedUrlResetRef = useRef<string | null>(null);
  const hasOpenedRequestedEditorRef = useRef<string | null>(null);
  const currentSavedRecipe = currentRecipeSourceUrl
    ? savedId
      ? routeSavedRecipe
      : getSavedRecipeBySourceUrl(currentRecipeSourceUrl)
    : routeSavedRecipe;
  const isSharedRecipeRoute = routeSharedRecipe != null;
  const currentSavedRecipeId = currentSavedRecipe?.id;
  const handleCookModeFinish = useCallback(() => {
    if (!currentSavedRecipeId || isSharedRecipeRoute) {
      return;
    }

    incrementRecipeTimesCooked(currentSavedRecipeId);
  }, [currentSavedRecipeId, incrementRecipeTimesCooked, isSharedRecipeRoute]);
  const isCurrentStarterRecipe = currentSavedRecipe?.isStarter === true;
  const canEditSharedRecipe = routeSharedRecipe?.ownerUserId === user?.id;
  const editableRecipe = routeSharedRecipeRecord ?? currentSavedRecipe;
  const displayedRecipe =
    extraction.state.state === "success"
      ? (editableRecipe?.recipe ?? extraction.state.recipe)
      : undefined;
  const isCurrentRecipeSaved = currentSavedRecipe != null;
  const isCurrentRecipeShared =
    routeSharedRecipe != null ||
    Boolean(currentSavedRecipe?.sharedRecipeId) ||
    Boolean(
      currentRecipeSourceUrl &&
      routeSharedRecipe == null &&
      currentSavedRecipe?.sharedRecipeId != null
    );
  const currentSaveGate =
    extraction.state.state === "success"
      ? getSaveLimitStatus({ isExistingRecord: isCurrentRecipeSaved })
      : { allowed: true };
  const sourceUrl = currentRecipeSourceUrl ?? url;
  const sourceLabel = getSourceLabel(sourceUrl);
  const sourceImages =
    editableRecipe?.sourceImages ??
    (extraction.state.state === "success" ? extraction.state.sourceImages : undefined);
  const shoppingRecipeId = truncateShoppingRecipeId(
    currentSavedRecipe?.sharedRecipeId ??
      currentSavedRecipe?.id ??
      routeSharedRecipe?.id ??
      displayedRecipe?.sourceUrl ??
      "recipe"
  );
  const openShoppingSheet = useCallback((context: RecipeShoppingActionContext) => {
    setShoppingSheetConfig(context);
  }, []);
  const hasSourceImages = sourceImages != null && sourceImages.length > 0;
  const isSharedRecipeRequest = sharedId != null;
  const isSharedRecipeMissing =
    isSharedRecipeRequest && hasLoadedSharedRecipes && routeSharedRecipe == null;
  const previousExtractionHapticStateRef = useRef(extraction.state.state);
  const lastExtractionWarningKeyRef = useRef<string | null>(null);
  const openedRecipeKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!displayedRecipe) {
      return;
    }

    const openedKey = sharedId
      ? `shared:${sharedId}`
      : savedId
        ? `saved:${savedId}`
        : `source:${displayedRecipe.sourceUrl}`;

    if (openedRecipeKeyRef.current === openedKey) {
      return;
    }

    openedRecipeKeyRef.current = openedKey;
    trackMobileEvent({
      eventName: "recipe_opened",
      routeOrScreen: "recipe",
      properties: {
        surface: sharedId
          ? "shared_link"
          : savedId || currentSavedRecipe
            ? "recipe_detail"
            : "import_result"
      }
    });
  }, [currentSavedRecipe, displayedRecipe, savedId, sharedId]);

  const finishSaveSuccessFeedback = useCallback(() => {
    triggerRecipeBookBounce();
    success();
  }, []);

  const playSaveSuccessFeedback = useCallback(() => {
    void AccessibilityInfo.isReduceMotionEnabled()
      .then((isReduceMotionEnabled) => {
        if (isReduceMotionEnabled) {
          finishSaveSuccessFeedback();
          return;
        }

        setSaveTossKey((current) => current + 1);
        setIsSaveTossVisible(true);
      })
      .catch(() => {
        setSaveTossKey((current) => current + 1);
        setIsSaveTossVisible(true);
      });
  }, [finishSaveSuccessFeedback]);

  const handleSaveTossComplete = useCallback(() => {
    setIsSaveTossVisible(false);
    finishSaveSuccessFeedback();
  }, [finishSaveSuccessFeedback]);

  useEffect(() => {
    const previousState = previousExtractionHapticStateRef.current;

    if (extraction.state.state === "success" && previousState === "loading") {
      success();
    }

    if (extraction.state.state === "failure" || extraction.state.state === "retryable") {
      const warningKey = `${extraction.state.state}:${extraction.state.message}`;

      if (lastExtractionWarningKeyRef.current !== warningKey) {
        warn();
        lastExtractionWarningKeyRef.current = warningKey;
      }
    } else {
      lastExtractionWarningKeyRef.current = null;
    }

    previousExtractionHapticStateRef.current = extraction.state.state;
  }, [extraction.state]);

  useEffect(() => {
    if (savedId || extraction.state.state !== "success") {
      return;
    }

    const extractedSourceUrl = extraction.state.recipe.sourceUrl;

    if (hasRequestedUrlResetRef.current === extractedSourceUrl) {
      return;
    }

    hasRequestedUrlResetRef.current = extractedSourceUrl;
    requestRecipeUrlReset();
  }, [extraction.state, savedId]);

  useEffect(() => {
    if (sharedId && !routeSharedRecipe && !hasLoadedSharedRecipes) {
      void refreshSharedRecipes();
    }
  }, [hasLoadedSharedRecipes, refreshSharedRecipes, routeSharedRecipe, sharedId]);

  const openRecipeEditor = () => {
    if (extraction.state.state !== "success" || !editableRecipe) {
      return;
    }

    const recipe = editableRecipe.recipe;
    setDraftTitle(recipe.title);
    setDraftServings(recipe.servings ?? "");
    setDraftIngredients(formatEditableIngredients(recipe.ingredients));
    setDraftSteps(recipe.steps.length > 0 ? recipe.steps.map((step) => step.text) : [""]);
    setDraftNotes(editableRecipe.notes ?? "");
    setEditorError(null);
    setIsEditorVisible(true);
  };

  const closeRecipeEditor = () => {
    if (isEditorSaving) {
      return;
    }

    setIsEditorVisible(false);
    setEditorError(null);
  };

  const applyRecipeEdits = async () => {
    if (isEditorSaving || extraction.state.state !== "success" || !editableRecipe) {
      return;
    }

    const title = draftTitle.trim();
    const ingredients = splitEditableIngredients(draftIngredients);
    const steps = draftSteps.map((step) => step.trim()).filter(Boolean);

    if (!title || ingredients.length === 0 || steps.length === 0) {
      setEditorError("Title, ingredients, and method all need at least one entry.");
      return;
    }

    const editedRecipe: Recipe = {
      ...editableRecipe.recipe,
      title,
      servings: draftServings.trim() || null,
      ingredients,
      steps: steps.map((text, index) => ({ index: index + 1, text }))
    };

    setIsEditorSaving(true);

    try {
      if (isSharedRecipeRoute && routeSharedRecipe) {
        const didUpdate = await updateSharedRecipe(routeSharedRecipe.id, {
          notes: draftNotes.trim() || undefined,
          recipe: editedRecipe
        });

        if (!didUpdate) {
          setEditorError("This shared recipe could not be saved. Try again.");
          return;
        }
      } else {
        const didUpdate = updateRecipe(editableRecipe.id, {
          notes: draftNotes.trim() || undefined,
          recipe: editedRecipe
        });

        if (!didUpdate) {
          setEditorError("This saved recipe is no longer available.");
          return;
        }
      }

      setIsEditorVisible(false);
      setEditorError(null);
    } finally {
      setIsEditorSaving(false);
    }
  };

  const addDraftStep = () => {
    setDraftSteps((current) => [...current, ""]);
  };

  const removeDraftStep = (stepIndex: number) => {
    setDraftSteps((current) => {
      const nextSteps = current.filter((_, index) => index !== stepIndex);
      return nextSteps.length > 0 ? nextSteps : [""];
    });
  };

  const updateDraftStep = (stepIndex: number, value: string) => {
    setDraftSteps((current) => current.map((step, index) => (index === stepIndex ? value : step)));
  };

  const handleSaveRecipe = async (target: "personal" | "family" | "both" = "personal") => {
    if (extraction.state.state !== "success") {
      return;
    }

    if (!hasLoadedSavedRecipes) {
      return;
    }

    const isSaveTargetAction = isSaveTargetModalVisible;

    if (isSaveTargetAction) {
      if (isSaveTargetSaving) {
        return;
      }

      setIsSaveTargetSaving(true);
    }

    try {
      if (target !== "personal") {
        const result = await saveRecipeToTargets(extraction.state, target);

        if (!result.saved) {
          setSaveLimitMessage(result.message ?? "This recipe could not be saved.");
          return;
        }

        setSaveLimitMessage(result.message ?? null);
        setIsSaveTargetModalVisible(false);
        playSaveSuccessFeedback();
        return;
      }

      if (isCurrentRecipeSaved) {
        if (currentSavedRecipe) {
          setRemoveRecipeConfirmation({
            message: `\u201c${displayedRecipe?.title ?? currentSavedRecipe.recipe.title}\u201d will be removed from your cookbook.`,
            onConfirm: () => {
              warn();
              removeRecipe(currentSavedRecipe.id);
              setSaveLimitMessage(null);
            },
            title: "Remove recipe?"
          });
        }
        return;
      }

      const result = await saveRecipe(extraction.state);

      if (!result.saved) {
        setSaveLimitMessage(result.message ?? "Upgrade for unlimited saves.");
        return;
      }

      setSaveLimitMessage(result.message ?? null);

      if (isSaveTargetAction) {
        setIsSaveTargetModalVisible(false);
      }

      playSaveSuccessFeedback();
    } finally {
      if (isSaveTargetAction) {
        setIsSaveTargetSaving(false);
      }
    }
  };

  const handleSaveAction = () => {
    if (!currentSaveGate.allowed && !isCurrentRecipeSaved) {
      showUpgradeMoment("save_limit");
      return;
    }

    if (!isCurrentRecipeSaved && canUseSharedRecipeBook) {
      setIsSaveTargetModalVisible(true);
      return;
    }

    void handleSaveRecipe();
  };

  const handleShareAction = () => {
    if (!currentSavedRecipe) {
      return;
    }

    const action = currentSavedRecipe.sharedRecipeId
      ? unshareRecipe(currentSavedRecipe.id)
      : shareRecipe(currentSavedRecipe.id);

    void action.then((result) => {
      if (!result.saved) {
        setSaveLimitMessage(result.message ?? "This recipe could not be shared.");
        return;
      }

      setSaveLimitMessage(null);
    });
  };

  const handleShareCardAction = () => {
    if (!displayedRecipe || isShareCardSharing) {
      return;
    }

    setIsShareCardSharing(true);

    requestAnimationFrame(() => {
      void (async () => {
        try {
          const capturedUri = await captureRef(shareCardRef, {
            format: "png",
            quality: 1,
            result: "tmpfile"
          });
          const shareUri = capturedUri.startsWith("file://")
            ? capturedUri
            : `file://${capturedUri}`;

          await shareRecipeCardImage(displayedRecipe, shareUri);
          setSaveLimitMessage(null);
        } catch {
          setSaveLimitMessage("This share card could not be created. Try again.");
        } finally {
          setIsShareCardSharing(false);
        }
      })();
    });
  };

  const handleRemoveSharedRecipe = () => {
    if (!routeSharedRecipe) {
      return;
    }

    setRemoveRecipeConfirmation({
      message: `Remove "${routeSharedRecipe.recipe.title}" from the Family recipe book?`,
      onConfirm: () => {
        void deleteSharedRecipe(routeSharedRecipe.id).then((result) => {
          if (!result.saved) {
            setSaveLimitMessage(result.message ?? "This shared recipe could not be removed.");
            return;
          }

          setSaveLimitMessage(null);
          router.back();
        });
      },
      title: "Unshare recipe?"
    });
  };

  const handleDuplicateRecipe = () => {
    if (!hasLoadedSavedRecipes) {
      return;
    }

    const result = routeSharedRecipe
      ? cloneSharedRecipe(routeSharedRecipe.id)
      : currentSavedRecipe
        ? cloneRecipe(currentSavedRecipe.id)
        : null;

    if (!result) {
      return;
    }

    if (!result.saved || !result.recipeId) {
      if (!result.allowed && result.message?.startsWith("Your free Cookbook holds")) {
        showUpgradeMoment("save_limit");
        return;
      }

      setSaveLimitMessage(result.message ?? "This saved recipe could not be duplicated.");
      return;
    }

    setSaveLimitMessage(null);
    router.replace({
      pathname: "/recipe",
      params: {
        edit: "1",
        savedId: result.recipeId
      }
    });
  };

  useEffect(() => {
    if (edit !== "1" || extraction.state.state !== "success" || !editableRecipe) {
      return;
    }

    if (hasOpenedRequestedEditorRef.current === editableRecipe.id) {
      return;
    }

    hasOpenedRequestedEditorRef.current = editableRecipe.id;
    openRecipeEditor();
  }, [editableRecipe, edit, extraction.state.state]);

  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={styles.container} showsVerticalScrollIndicator={false}>
        <View style={styles.sourceTile}>
          <Pressable
            accessibilityLabel={hasSourceImages ? "View scanned recipe images" : undefined}
            accessibilityRole={hasSourceImages ? "button" : undefined}
            disabled={!hasSourceImages}
            onPress={() => setIsSourceImageViewerVisible(true)}
            style={({ pressed }) => [styles.sourceTileContent, pressed && styles.pressed]}
          >
            <View style={styles.sourceCopy}>
              <AppText muted numberOfLines={1} style={styles.sourceTitle}>
                From {sourceLabel}
              </AppText>
            </View>
            {hasSourceImages ? (
              <View style={styles.sourceViewAction}>
                <AppText style={styles.sourceViewActionText}>View scan</AppText>
                <MaterialCommunityIcons color={appColors.accent} name="chevron-right" size={18} />
              </View>
            ) : null}
          </Pressable>

          {hasSourceImages ? (
            <ScrollView
              contentContainerStyle={styles.sourceThumbnailRow}
              horizontal
              showsHorizontalScrollIndicator={false}
            >
              {sourceImages.map((image, index) => (
                <Pressable
                  accessibilityLabel={`View scanned recipe image ${index + 1}`}
                  accessibilityRole="button"
                  key={`${image.mimeType}-${index}`}
                  onPress={() => setIsSourceImageViewerVisible(true)}
                  style={({ pressed }) => [styles.sourceThumbnailButton, pressed && styles.pressed]}
                >
                  <Image source={{ uri: image.dataUrl }} style={styles.sourceThumbnail} />
                </Pressable>
              ))}
            </ScrollView>
          ) : null}
        </View>

        <SourceImageViewer
          images={sourceImages ?? []}
          onClose={() => setIsSourceImageViewerVisible(false)}
          visible={isSourceImageViewerVisible}
        />

        {isSharedRecipeRequest && !hasLoadedSharedRecipes ? (
          <AppSurface style={styles.loadingCard}>
            <ActivityIndicator color={appColors.accent} />
            <View style={styles.statusCopy}>
              <AppText variant="headline">Loading shared recipe</AppText>
              <AppText muted>Checking the Family recipe book.</AppText>
            </View>
          </AppSurface>
        ) : null}

        {isSharedRecipeMissing ? (
          <StatusCard
            body="This recipe may have been unshared, or your account may no longer have access to this Family household."
            primaryAction={{
              label: "Back",
              onPress: () => router.back()
            }}
            title="Shared recipe unavailable"
          />
        ) : null}

        {extraction.state.state === "empty" && !isSharedRecipeRequest ? (
          <StatusCard
            body="Head back and paste a recipe source to keep going."
            primaryAction={{
              label: "Paste a link",
              onPress: () => router.replace("/")
            }}
            title="There is no link to process"
          />
        ) : null}

        {extraction.state.state === "loading" ? (
          <AppSurface style={styles.loadingCard}>
            <ActivityIndicator color={appColors.accent} />
            <View style={styles.statusCopy}>
              <AppText variant="headline">
                {extraction.state.attempt === "fallback"
                  ? "Taking another look"
                  : "Reading the recipe"}
              </AppText>
              <ExtractionLoadingCopy />
            </View>
          </AppSurface>
        ) : null}

        {extraction.state.state === "retryable" ? (
          <StatusCard
            body={extraction.state.message}
            primaryAction={
              extraction.state.allowFallback
                ? {
                    label: "Try again with more help",
                    onPress: extraction.retryWithFallback
                  }
                : extraction.state.suggestedAction === "retry_primary"
                  ? {
                      label: "Retry extraction",
                      onPress: extraction.retryPrimary
                    }
                  : undefined
            }
            secondaryAction={{
              label:
                extraction.state.suggestedAction === "retry_primary"
                  ? "Paste another link"
                  : "Back",
              onPress: () => router.replace("/")
            }}
            title={extractionErrorTitle}
          />
        ) : null}

        {extraction.state.state === "failure" ? (
          <StatusCard
            body={extraction.state.message}
            primaryAction={
              extraction.state.reason === "plan_limit"
                ? {
                    label: "View Plans",
                    onPress: () => router.push("/upgrade" as never)
                  }
                : extraction.state.allowFallback ||
                    extraction.state.suggestedAction === "retry_fallback"
                  ? {
                      label: "Try again with more help",
                      onPress: extraction.retryWithFallback
                    }
                  : extraction.state.suggestedAction === "retry_primary"
                    ? {
                        label: "Retry extraction",
                        onPress: extraction.retryPrimary
                      }
                    : undefined
            }
            secondaryAction={{
              label: "Paste another link",
              onPress: () => router.replace("/")
            }}
            title={extractionErrorTitle}
          />
        ) : null}

        {displayedRecipe ? (
          <RecipeResultCard
            actionSlot={(shoppingContext) =>
              extraction.state.state === "success" ? (
                <View style={styles.actions}>
                  <View style={styles.recipeActions}>
                    <View style={styles.recipeActionRow}>
                      <RecipeActionButton
                        icon="cart-plus"
                        label="Add to shopping"
                        onPress={() => openShoppingSheet(shoppingContext)}
                        variant="outline"
                      />
                      <RecipeActionButton
                        disabled={isShareCardSharing}
                        icon="image-outline"
                        label={isShareCardSharing ? "Sharing" : "Share card"}
                        onPress={handleShareCardAction}
                        variant="outline"
                      />
                    </View>

                    <View style={styles.recipeActionRow}>
                      {(isCurrentRecipeSaved && !isSharedRecipeRoute) ||
                      (isSharedRecipeRoute && canEditSharedRecipe) ? (
                        <RecipeActionButton
                          disabled={!hasLoadedSavedRecipes}
                          icon="pencil-outline"
                          label="Edit"
                          onPress={openRecipeEditor}
                          variant="outline"
                        />
                      ) : null}

                      {isCurrentRecipeSaved || isSharedRecipeRoute ? (
                        <RecipeActionButton
                          disabled={!hasLoadedSavedRecipes}
                          icon="content-copy"
                          label={isSharedRecipeRoute ? "Save copy" : "Duplicate"}
                          onPress={handleDuplicateRecipe}
                          variant="outline"
                        />
                      ) : null}

                      {!isSharedRecipeRoute ? (
                        <RecipeActionButton
                          disabled={!hasLoadedSavedRecipes}
                          icon={
                            !currentSaveGate.allowed && !isCurrentRecipeSaved
                              ? "star-circle-outline"
                              : isCurrentRecipeSaved
                                ? "bookmark-remove-outline"
                                : "bookmark-plus-outline"
                          }
                          label={
                            !hasLoadedSavedRecipes
                              ? "Loading"
                              : !currentSaveGate.allowed && !isCurrentRecipeSaved
                                ? "View Plans"
                                : isCurrentRecipeSaved
                                  ? "Remove"
                                  : "Save recipe"
                          }
                          onPress={handleSaveAction}
                          variant={
                            isCurrentRecipeSaved
                              ? "danger"
                              : !currentSaveGate.allowed
                                ? "outline"
                                : "primary"
                          }
                        />
                      ) : null}
                    </View>

                    {isCurrentRecipeSaved && canUseSharedRecipeBook && !isCurrentStarterRecipe ? (
                      <View style={styles.recipeActionRow}>
                        <RecipeActionButton
                          disabled={!hasLoadedSharedRecipes}
                          icon={
                            isCurrentRecipeShared
                              ? "account-multiple-minus-outline"
                              : "account-multiple-plus-outline"
                          }
                          label={isCurrentRecipeShared ? "Unshare" : "Share"}
                          onPress={handleShareAction}
                          variant={isCurrentRecipeShared ? "danger" : "outline"}
                        />
                      </View>
                    ) : null}

                    {isSharedRecipeRoute && canEditSharedRecipe ? (
                      <View style={styles.recipeActionRow}>
                        <RecipeActionButton
                          disabled={!hasLoadedSharedRecipes}
                          icon="account-multiple-minus-outline"
                          label="Unshare"
                          onPress={handleRemoveSharedRecipe}
                          variant="danger"
                        />
                      </View>
                    ) : null}
                  </View>

                  {saveLimitMessage || (!isCurrentRecipeSaved && !currentSaveGate.allowed) ? (
                    <AppText muted style={styles.saveMessage}>
                      {saveLimitMessage ?? currentSaveGate.message}
                    </AppText>
                  ) : null}
                  {isSharedRecipeRoute ? (
                    <AppText muted style={styles.saveMessage}>
                      {routeSharedRecipe
                        ? `Owned by ${getSharedRecipeOwnerLabel(routeSharedRecipe)}`
                        : "This shared recipe is no longer available."}
                    </AppText>
                  ) : null}
                </View>
              ) : undefined
            }
            onCookModeFinish={handleCookModeFinish}
            onAddIngredientsToShoppingList={openShoppingSheet}
            eyebrowLabel={isCurrentRecipeSaved || isSharedRecipeRoute ? "Recipe" : "Recipe Preview"}
            notes={editableRecipe?.notes}
            recipe={displayedRecipe}
          />
        ) : null}

        <SaveTargetModal
          isSaving={isSaveTargetSaving}
          onClose={() => {
            if (!isSaveTargetSaving) {
              setIsSaveTargetModalVisible(false);
            }
          }}
          onSave={(target) => {
            void handleSaveRecipe(target);
          }}
          visible={isSaveTargetModalVisible}
        />

        {displayedRecipe && shoppingSheetConfig ? (
          <AddRecipeIngredientsSheet
            onClose={() => setShoppingSheetConfig(null)}
            recipe={displayedRecipe}
            recipeId={shoppingRecipeId}
            scaleFactor={shoppingSheetConfig.scaleFactor}
            unitMode={shoppingSheetConfig.unitMode}
            visible={shoppingSheetConfig != null}
          />
        ) : null}

        <RecipeEditorModal
          draftIngredients={draftIngredients}
          draftNotes={draftNotes}
          draftServings={draftServings}
          draftSteps={draftSteps}
          draftTitle={draftTitle}
          error={editorError}
          isSaving={isEditorSaving}
          onAddStep={addDraftStep}
          onApply={() => {
            void applyRecipeEdits();
          }}
          onChangeStep={updateDraftStep}
          onClose={closeRecipeEditor}
          onRemoveStep={removeDraftStep}
          setDraftIngredients={setDraftIngredients}
          setDraftNotes={setDraftNotes}
          setDraftServings={setDraftServings}
          setDraftTitle={setDraftTitle}
          visible={isEditorVisible}
        />
        <AppDialog
          actions={
            removeRecipeConfirmation
              ? [
                  {
                    label:
                      removeRecipeConfirmation.title === "Unshare recipe?"
                        ? "Keep shared"
                        : "Cancel",
                    onPress: () => setRemoveRecipeConfirmation(null),
                    variant: "outline"
                  },
                  {
                    label:
                      removeRecipeConfirmation.title === "Unshare recipe?" ? "Unshare" : "Remove",
                    onPress: () => {
                      const action = removeRecipeConfirmation.onConfirm;
                      setRemoveRecipeConfirmation(null);
                      action();
                    },
                    variant: "danger"
                  }
                ]
              : []
          }
          message={removeRecipeConfirmation?.message ?? ""}
          onRequestClose={() => setRemoveRecipeConfirmation(null)}
          title={removeRecipeConfirmation?.title ?? ""}
          visible={removeRecipeConfirmation != null}
        />
      </ScrollView>

      <SaveTossOverlay
        animationKey={saveTossKey}
        onComplete={handleSaveTossComplete}
        targetTop={insets.top + 32}
        visible={isSaveTossVisible}
        windowWidth={windowWidth}
      />

      {displayedRecipe ? (
        <View collapsable={false} pointerEvents="none" style={styles.hiddenShareCard}>
          <ShareCard ref={shareCardRef} recipe={displayedRecipe} sourceLabel={sourceLabel} />
        </View>
      ) : null}
    </View>
  );
}

type IconName = ComponentProps<typeof MaterialCommunityIcons>["name"];

const SaveTossOverlay = ({
  animationKey,
  onComplete,
  targetTop,
  visible,
  windowWidth
}: {
  animationKey: number;
  onComplete: () => void;
  targetTop: number;
  visible: boolean;
  windowWidth: number;
}) => {
  const progress = useSharedValue(0);
  const startLeft = Math.max(28, windowWidth / 2 - 58);
  const startTop = Math.max(230, targetTop + 190);
  const translateX = 40 - startLeft;
  const translateY = targetTop - startTop;

  useEffect(() => {
    if (!visible) {
      progress.value = 0;
      return;
    }

    progress.value = 0;
    progress.value = withTiming(
      1,
      {
        duration: SAVE_TOSS_DURATION_MS,
        easing: ReanimatedEasing.in(ReanimatedEasing.cubic)
      },
      (finished) => {
        if (finished) {
          runOnJS(onComplete)();
        }
      }
    );
  }, [animationKey, onComplete, progress, visible]);

  const animatedStyle = useAnimatedStyle(() => {
    const arcLift = Math.sin(progress.value * Math.PI) * -42;

    return {
      opacity: 1 - progress.value,
      transform: [
        {
          translateX: progress.value * translateX
        },
        {
          translateY: progress.value * translateY + arcLift
        },
        {
          scale: 1 - progress.value * 0.85
        }
      ]
    };
  });

  if (!visible) {
    return null;
  }

  return (
    <Reanimated.View
      pointerEvents="none"
      style={[
        styles.saveTossCard,
        {
          left: startLeft,
          top: startTop
        },
        animatedStyle
      ]}
    >
      <View style={styles.saveTossCardHeader} />
      <View style={styles.saveTossCardLine} />
      <View style={[styles.saveTossCardLine, styles.saveTossCardLineShort]} />
    </Reanimated.View>
  );
};

function SourceImageViewer({
  images,
  onClose,
  visible
}: {
  images: { dataUrl: string; mimeType: string }[];
  onClose: () => void;
  visible: boolean;
}) {
  return (
    <Modal animationType="slide" onRequestClose={onClose} visible={visible}>
      <SafeAreaView style={styles.sourceViewerScreen}>
        <View style={styles.sourceViewerHeader}>
          <View style={styles.statusCopy}>
            <AppText tone="accent" variant="label">
              Source
            </AppText>
            <AppText variant="title">Scanned Images</AppText>
          </View>
          <AppButton label="Done" onPress={onClose} />
        </View>

        <ScrollView
          contentContainerStyle={styles.sourceViewerContent}
          showsVerticalScrollIndicator={false}
        >
          {images.map((image, index) => (
            <View key={`${image.mimeType}-${index}`} style={styles.sourceViewerImageFrame}>
              <Image
                resizeMode="contain"
                source={{ uri: image.dataUrl }}
                style={styles.sourceViewerImage}
              />
              <AppText muted style={styles.sourceViewerCaption}>
                {images.length > 1 ? `Image ${index + 1} of ${images.length}` : "Original scan"}
              </AppText>
            </View>
          ))}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

const ExtractionLoadingCopy = () => {
  const [copyIndex, setCopyIndex] = useState(0);
  const copyProgress = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const timer = setInterval(() => {
      Animated.timing(copyProgress, {
        duration: EXTRACTION_COPY_SWAP_MS,
        toValue: 1,
        useNativeDriver: true
      }).start(({ finished }) => {
        if (!finished) {
          return;
        }

        setCopyIndex((current) => (current + 1) % EXTRACTION_LOADING_COPY.length);
        copyProgress.setValue(-1);
        Animated.timing(copyProgress, {
          duration: EXTRACTION_COPY_SWAP_MS,
          toValue: 0,
          useNativeDriver: true
        }).start();
      });
    }, EXTRACTION_COPY_INTERVAL_MS);

    return () => {
      clearInterval(timer);
      copyProgress.stopAnimation();
    };
  }, [copyProgress]);

  return (
    <Animated.View
      style={{
        opacity: copyProgress.interpolate({
          inputRange: [-1, 0, 1],
          outputRange: [0, 1, 0]
        }),
        transform: [
          {
            translateY: copyProgress.interpolate({
              inputRange: [-1, 0, 1],
              outputRange: [8, 0, -8]
            })
          }
        ]
      }}
    >
      <AppText muted>{EXTRACTION_LOADING_COPY[copyIndex]}</AppText>
    </Animated.View>
  );
};

const RecipeActionButton = ({
  disabled = false,
  icon,
  label,
  onPress,
  variant = "outline"
}: {
  disabled?: boolean;
  icon: IconName;
  label: string;
  onPress: () => void;
  variant?: "danger" | "outline" | "primary";
}) => (
  <Pressable
    accessibilityRole="button"
    disabled={disabled}
    onPress={onPress}
    style={({ pressed }) => [
      styles.recipeActionButton,
      variant === "primary" && styles.recipeActionButtonPrimary,
      variant === "danger" && styles.recipeActionButtonDanger,
      disabled && styles.recipeActionButtonDisabled,
      pressed && !disabled && styles.pressed
    ]}
  >
    <MaterialCommunityIcons
      color={
        variant === "primary" && !disabled
          ? appColors.canvas
          : variant === "danger" && !disabled
            ? appColors.dangerText
            : appColors.accent
      }
      name={icon}
      size={18}
    />
    <AppText
      style={[
        styles.recipeActionText,
        variant === "primary" && !disabled && styles.recipeActionTextPrimary,
        variant === "danger" && !disabled && styles.recipeActionTextDanger
      ]}
    >
      {label}
    </AppText>
  </Pressable>
);

const StatusCard = ({
  title,
  body,
  primaryAction,
  secondaryAction
}: {
  title: string;
  body: string;
  primaryAction?:
    | {
        label: string;
        onPress: () => void | Promise<void>;
      }
    | undefined;
  secondaryAction?:
    | {
        label: string;
        onPress: () => void | Promise<void>;
      }
    | undefined;
}) => (
  <AppSurface style={styles.statusCard}>
    <View style={styles.statusCopy}>
      <AppText variant="headline">{title}</AppText>
      <AppText muted>{body}</AppText>
    </View>

    <View style={styles.actions}>
      {primaryAction ? (
        <AppButton label={primaryAction.label} onPress={primaryAction.onPress} />
      ) : null}
      {secondaryAction ? (
        <AppButton
          label={secondaryAction.label}
          onPress={secondaryAction.onPress}
          variant={primaryAction ? "secondary" : "primary"}
        />
      ) : null}
    </View>
  </AppSurface>
);

const SaveTargetModal = ({
  isSaving,
  onClose,
  onSave,
  visible
}: {
  isSaving: boolean;
  onClose: () => void;
  onSave: (target: "personal" | "family" | "both") => void;
  visible: boolean;
}) => (
  <Modal
    animationType="fade"
    onRequestClose={isSaving ? () => undefined : onClose}
    transparent
    visible={visible}
  >
    <View style={styles.saveTargetBackdrop}>
      <AppSurface style={styles.saveTargetCard}>
        <View style={styles.statusCopy}>
          <AppText variant="title">{isSaving ? "Saving Recipe" : "Save Recipe"}</AppText>
          <AppText muted>Choose where this recipe should live.</AppText>
        </View>
        <View style={styles.actions}>
          <AppButton disabled={isSaving} label="Personal book" onPress={() => onSave("personal")} />
          <AppButton
            disabled={isSaving}
            label="Family book"
            onPress={() => onSave("family")}
            variant="secondary"
          />
          <AppButton
            disabled={isSaving}
            label="Both"
            onPress={() => onSave("both")}
            variant="secondary"
          />
          <AppButton disabled={isSaving} label="Cancel" onPress={onClose} variant="ghost" />
        </View>
      </AppSurface>
    </View>
  </Modal>
);

const RecipeEditorModal = ({
  draftIngredients,
  draftNotes,
  draftServings,
  draftSteps,
  draftTitle,
  error,
  isSaving,
  onAddStep,
  onApply,
  onChangeStep,
  onClose,
  onRemoveStep,
  setDraftIngredients,
  setDraftNotes,
  setDraftServings,
  setDraftTitle,
  visible
}: {
  draftIngredients: string;
  draftNotes: string;
  draftServings: string;
  draftSteps: string[];
  draftTitle: string;
  error: string | null;
  isSaving: boolean;
  onAddStep: () => void;
  onApply: () => void;
  onChangeStep: (stepIndex: number, value: string) => void;
  onClose: () => void;
  onRemoveStep: (stepIndex: number) => void;
  setDraftIngredients: (value: string) => void;
  setDraftNotes: (value: string) => void;
  setDraftServings: (value: string) => void;
  setDraftTitle: (value: string) => void;
  visible: boolean;
}) => {
  const scrollViewRef = useRef<ScrollView>(null);
  const fieldLayoutsRef = useRef<Record<string, { height: number; offsetY: number }>>({});
  const focusedEditorLayoutRef = useRef<{ height: number; offsetY: number } | null>(null);
  const editorScrollYRef = useRef(0);
  const [editorViewportHeight, setEditorViewportHeight] = useState(0);
  const keyboardBottomInset = useSmoothKeyboardInset({ enabled: visible });

  const keepEditorOffsetVisible = useCallback(
    (offsetY: number, rowHeight: number) => {
      const visibleViewportHeight =
        editorViewportHeight > 0
          ? Math.max(1, editorViewportHeight - keyboardBottomInset)
          : Math.max(1, rowHeight);
      const currentTop = editorScrollYRef.current;
      const currentBottom = currentTop + visibleViewportHeight;
      const fieldTop = Math.max(0, offsetY - 18);
      const fieldBottom = offsetY + rowHeight + 18;
      const nextOffsetY =
        fieldBottom > currentBottom
          ? fieldBottom - visibleViewportHeight
          : fieldTop < currentTop
            ? fieldTop
            : null;

      if (nextOffsetY == null) {
        return;
      }

      scrollViewRef.current?.scrollTo({
        animated: true,
        y: Math.max(0, nextOffsetY)
      });
    },
    [editorViewportHeight, keyboardBottomInset]
  );

  useEffect(() => {
    if (keyboardBottomInset <= 0 || focusedEditorLayoutRef.current == null) {
      return;
    }

    requestAnimationFrame(() => {
      const layout = focusedEditorLayoutRef.current;

      if (layout != null) {
        keepEditorOffsetVisible(layout.offsetY, layout.height);
      }
    });
  }, [keepEditorOffsetVisible, keyboardBottomInset]);

  const handleFocusedEditorLayout = (offsetY: number, rowHeight: number) => {
    focusedEditorLayoutRef.current = {
      height: rowHeight,
      offsetY
    };

    requestAnimationFrame(() => keepEditorOffsetVisible(offsetY, rowHeight));
  };

  const handleFieldLayout = (fieldKey: string, offsetY: number, height: number) => {
    fieldLayoutsRef.current[fieldKey] = {
      height,
      offsetY
    };
  };

  const handleFieldFocus = (fieldKey: string) => {
    const layout = fieldLayoutsRef.current[fieldKey];

    if (!layout) {
      return;
    }

    handleFocusedEditorLayout(layout.offsetY, layout.height);
  };

  return (
    <Modal
      animationType="slide"
      onRequestClose={isSaving ? () => undefined : onClose}
      presentationStyle="pageSheet"
      visible={visible}
    >
      <SafeAreaView style={styles.editorScreen}>
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          style={styles.editorKeyboardAvoiding}
        >
          <View style={styles.editorHeader}>
            <View style={styles.statusCopy}>
              <AppText tone="accent" variant="label">
                Saved Recipe
              </AppText>
              <AppText variant="title">Edit Your Copy</AppText>
            </View>
            <AppButton disabled={isSaving} label={isSaving ? "Saving" : "Done"} onPress={onApply} />
          </View>

          <ScrollView
            contentContainerStyle={[
              styles.editorContent,
              keyboardBottomInset > 0 && { paddingBottom: keyboardBottomInset + 18 }
            ]}
            keyboardShouldPersistTaps="handled"
            onLayout={(event) => setEditorViewportHeight(event.nativeEvent.layout.height)}
            onScroll={(event) => {
              editorScrollYRef.current = event.nativeEvent.contentOffset.y;
            }}
            ref={scrollViewRef}
            scrollEventThrottle={16}
            showsVerticalScrollIndicator={false}
          >
            {error ? (
              <AppSurface style={styles.editorError} tone="subtle">
                <AppText>{error}</AppText>
              </AppSurface>
            ) : null}

            <EditableField
              label="Title"
              onChangeText={setDraftTitle}
              onFocus={() => handleFieldFocus("title")}
              onLayout={(offsetY, height) => handleFieldLayout("title", offsetY, height)}
              value={draftTitle}
            />
            <EditableField
              label="Servings"
              onChangeText={setDraftServings}
              onFocus={() => handleFieldFocus("servings")}
              onLayout={(offsetY, height) => handleFieldLayout("servings", offsetY, height)}
              value={draftServings}
            />
            <EditableField
              label="Ingredients"
              multiline
              onChangeText={setDraftIngredients}
              onFocus={() => handleFieldFocus("ingredients")}
              onLayout={(offsetY, height) => handleFieldLayout("ingredients", offsetY, height)}
              value={draftIngredients}
            />
            <MethodStepsEditor
              onAddStep={onAddStep}
              onChangeStep={onChangeStep}
              onRemoveStep={onRemoveStep}
              onStepFocus={handleFocusedEditorLayout}
              steps={draftSteps}
            />
            <EditableField
              label="Personal Notes"
              multiline
              onChangeText={setDraftNotes}
              onFocus={() => handleFieldFocus("notes")}
              onLayout={(offsetY, height) => handleFieldLayout("notes", offsetY, height)}
              value={draftNotes}
            />
          </ScrollView>

          <View style={styles.editorFooter}>
            <AppButton disabled={isSaving} label="Cancel" onPress={onClose} variant="secondary" />
            <AppButton
              disabled={isSaving}
              label={isSaving ? "Saving" : "Save changes"}
              onPress={onApply}
            />
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
};

const MethodStepsEditor = ({
  onAddStep,
  onChangeStep,
  onRemoveStep,
  onStepFocus,
  steps
}: {
  onAddStep: () => void;
  onChangeStep: (stepIndex: number, value: string) => void;
  onRemoveStep: (stepIndex: number) => void;
  onStepFocus: (offsetY: number, rowHeight: number) => void;
  steps: string[];
}) => {
  const methodOffsetYRef = useRef(0);
  const stepListOffsetYRef = useRef(0);
  const pendingFocusStepIndexRef = useRef<number | null>(null);
  const stepLayoutsRef = useRef<Array<{ height: number; offsetY: number } | null>>([]);
  const stepInputRefs = useRef<Array<TextInput | null>>([]);

  useEffect(() => {
    stepLayoutsRef.current = stepLayoutsRef.current.slice(0, steps.length);
    stepInputRefs.current = stepInputRefs.current.slice(0, steps.length);
  }, [steps.length]);

  const handleAddStep = () => {
    pendingFocusStepIndexRef.current = steps.length;
    onAddStep();
  };

  const handleStepLayout = (stepIndex: number, rowOffsetY: number, rowHeight: number) => {
    const contentOffsetY = methodOffsetYRef.current + stepListOffsetYRef.current + rowOffsetY;

    stepLayoutsRef.current[stepIndex] = {
      height: rowHeight,
      offsetY: contentOffsetY
    };

    if (pendingFocusStepIndexRef.current !== stepIndex) {
      return;
    }

    pendingFocusStepIndexRef.current = null;

    requestAnimationFrame(() => {
      stepInputRefs.current[stepIndex]?.focus();
      onStepFocus(contentOffsetY, rowHeight);
    });
  };

  const handleStepFocus = (stepIndex: number) => {
    const layout = stepLayoutsRef.current[stepIndex];

    if (!layout) {
      return;
    }

    onStepFocus(layout.offsetY, layout.height);
  };

  return (
    <View
      onLayout={(event) => {
        methodOffsetYRef.current = event.nativeEvent.layout.y;
      }}
      style={styles.editorField}
    >
      <View style={styles.methodHeader}>
        <AppText tone="accent" variant="label">
          Method
        </AppText>
        <Pressable
          accessibilityLabel="Add method step"
          accessibilityRole="button"
          onPress={handleAddStep}
          style={({ pressed }) => [styles.stepToolButton, pressed && styles.pressed]}
        >
          <MaterialCommunityIcons color={appColors.accent} name="plus" size={18} />
          <AppText style={styles.stepToolButtonText}>Add step</AppText>
        </Pressable>
      </View>

      <View
        onLayout={(event) => {
          stepListOffsetYRef.current = event.nativeEvent.layout.y;
        }}
        style={styles.stepEditorList}
      >
        {steps.map((step, index) => (
          <View
            key={index}
            onLayout={(event) =>
              handleStepLayout(index, event.nativeEvent.layout.y, event.nativeEvent.layout.height)
            }
            style={styles.stepEditorRow}
          >
            <View style={styles.stepEditorBadge}>
              <AppText style={styles.stepEditorBadgeText}>{String(index + 1)}</AppText>
            </View>
            <TextInput
              multiline
              onChangeText={(value) => onChangeStep(index, value)}
              onFocus={() => handleStepFocus(index)}
              placeholder={`Step ${index + 1}`}
              placeholderTextColor={appColors.muted}
              ref={(element) => {
                stepInputRefs.current[index] = element;
              }}
              style={[styles.editorInput, styles.stepEditorInput]}
              textAlignVertical="top"
              value={step}
            />
            <Pressable
              accessibilityLabel={`Remove step ${index + 1}`}
              accessibilityRole="button"
              hitSlop={10}
              onPress={() => onRemoveStep(index)}
              style={({ pressed }) => [styles.removeStepButton, pressed && styles.pressed]}
            >
              <MaterialCommunityIcons color={appColors.muted} name="trash-can-outline" size={20} />
            </Pressable>
          </View>
        ))}
      </View>
    </View>
  );
};

const EditableField = ({
  label,
  multiline,
  onChangeText,
  onFocus,
  onLayout,
  value
}: {
  label: string;
  multiline?: boolean;
  onChangeText: (value: string) => void;
  onFocus: () => void;
  onLayout: (offsetY: number, height: number) => void;
  value: string;
}) => (
  <View
    onLayout={(event) => onLayout(event.nativeEvent.layout.y, event.nativeEvent.layout.height)}
    style={styles.editorField}
  >
    <AppText
      tone={label === "Ingredients" || label === "Personal Notes" ? "accent" : "default"}
      variant="label"
    >
      {label}
    </AppText>
    <TextInput
      multiline={multiline}
      onChangeText={onChangeText}
      onFocus={onFocus}
      placeholderTextColor={appColors.muted}
      style={[styles.editorInput, multiline && styles.editorInputMultiline]}
      textAlignVertical={multiline ? "top" : "center"}
      value={value}
    />
  </View>
);

const styles = StyleSheet.create({
  actions: {
    gap: 10
  },
  container: {
    backgroundColor: appColors.background,
    gap: 18,
    padding: 20
  },
  hiddenShareCard: {
    left: -1000,
    opacity: 0,
    position: "absolute",
    top: 0
  },
  editorContent: {
    gap: 16,
    padding: 18
  },
  editorError: {
    borderColor: appColors.accent,
    borderWidth: 1
  },
  editorField: {
    gap: 8
  },
  editorFooter: {
    backgroundColor: appColors.surface,
    borderTopColor: appColors.border,
    borderTopWidth: 1,
    flexDirection: "row",
    gap: 10,
    padding: 18
  },
  editorHeader: {
    alignItems: "center",
    backgroundColor: appColors.surface,
    borderBottomColor: appColors.border,
    borderBottomWidth: 1,
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: 18,
    paddingVertical: 14
  },
  editorInput: {
    backgroundColor: appColors.surface,
    borderColor: appColors.border,
    borderRadius: 12,
    borderWidth: 1,
    color: appColors.text,
    fontSize: 16,
    lineHeight: 22,
    minHeight: 48,
    paddingHorizontal: 14,
    paddingVertical: 10
  },
  editorInputMultiline: {
    minHeight: 136
  },
  editorKeyboardAvoiding: {
    flex: 1
  },
  editorScreen: {
    backgroundColor: appColors.background,
    flex: 1
  },
  methodHeader: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between"
  },
  pressed: {
    opacity: pressedOpacity.firm,
    transform: [{ scale: pressedScale.standard }]
  },
  recipeActionButton: {
    alignItems: "center",
    backgroundColor: "transparent",
    borderColor: appColors.border,
    borderRadius: 12,
    borderWidth: 1,
    flex: 1,
    flexDirection: "row",
    gap: 6,
    justifyContent: "center",
    minHeight: 42,
    minWidth: 0,
    paddingHorizontal: 10
  },
  recipeActionRow: {
    flexDirection: "row",
    gap: 10,
    width: "100%"
  },
  recipeActionButtonDisabled: {
    opacity: 0.5
  },
  recipeActionButtonDanger: {
    backgroundColor: "transparent",
    borderColor: "rgba(154, 82, 63, 0.42)"
  },
  recipeActionButtonPrimary: {
    backgroundColor: appColors.accent
  },
  recipeActionText: {
    color: appColors.accent,
    flexShrink: 1,
    fontSize: 15,
    fontWeight: "700",
    lineHeight: 20
  },
  recipeActionTextDanger: {
    color: appColors.dangerText
  },
  recipeActionTextPrimary: {
    color: appColors.canvas
  },
  recipeActions: {
    gap: 10
  },
  removeStepButton: {
    alignItems: "center",
    borderRadius: 999,
    height: 40,
    justifyContent: "center",
    marginTop: 4,
    width: 40
  },
  loadingCard: {
    alignItems: "flex-start",
    gap: 18
  },
  saveMessage: {
    flexBasis: "100%",
    fontSize: 14,
    lineHeight: 20
  },
  saveTossCard: {
    backgroundColor: appColors.surface,
    borderColor: appColors.border,
    borderRadius: 14,
    borderWidth: 1,
    elevation: Platform.OS === "android" ? 5 : 0,
    gap: 8,
    height: 74,
    padding: 12,
    position: "absolute",
    shadowColor: appColors.shadow,
    shadowOffset: { height: 8, width: 0 },
    shadowOpacity: 0.12,
    shadowRadius: 18,
    width: 116,
    zIndex: 50
  },
  saveTossCardHeader: {
    backgroundColor: appColors.accentSoft,
    borderRadius: 999,
    height: 14,
    width: 44
  },
  saveTossCardLine: {
    backgroundColor: appColors.border,
    borderRadius: 999,
    height: 8,
    width: "100%"
  },
  saveTossCardLineShort: {
    width: "68%"
  },
  saveTargetBackdrop: {
    alignItems: "center",
    backgroundColor: "rgba(31, 33, 29, 0.36)",
    flex: 1,
    justifyContent: "center",
    padding: 20
  },
  saveTargetCard: {
    gap: 18,
    maxWidth: 420,
    width: "100%"
  },
  sourceCopy: {
    flex: 1
  },
  screen: {
    backgroundColor: appColors.background,
    flex: 1
  },
  sourceTile: {
    gap: 10,
    paddingHorizontal: 2,
    paddingVertical: 2
  },
  sourceTileContent: {
    alignItems: "center",
    flexDirection: "row",
    gap: 10
  },
  sourceThumbnail: {
    backgroundColor: appColors.surface,
    borderRadius: 10,
    height: 72,
    width: 72
  },
  sourceThumbnailButton: {
    borderRadius: 10,
    overflow: "hidden"
  },
  sourceThumbnailRow: {
    gap: 10,
    paddingRight: 2
  },
  sourceTitle: {
    fontSize: 14,
    lineHeight: 20
  },
  sourceViewAction: {
    alignItems: "center",
    flexDirection: "row",
    gap: 2
  },
  sourceViewActionText: {
    color: appColors.accent,
    fontWeight: "700"
  },
  sourceViewerCaption: {
    textAlign: "center"
  },
  sourceViewerContent: {
    gap: 18,
    padding: 18
  },
  sourceViewerHeader: {
    alignItems: "center",
    backgroundColor: appColors.surface,
    borderBottomColor: appColors.border,
    borderBottomWidth: 1,
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: 18,
    paddingVertical: 14
  },
  sourceViewerImage: {
    aspectRatio: 1,
    width: "100%"
  },
  sourceViewerImageFrame: {
    backgroundColor: appColors.surface,
    borderColor: appColors.border,
    borderRadius: 16,
    borderWidth: 1,
    gap: 10,
    overflow: "hidden",
    padding: 10
  },
  sourceViewerScreen: {
    backgroundColor: appColors.background,
    flex: 1
  },
  stepEditorBadge: {
    alignItems: "center",
    backgroundColor: appColors.accentSoft,
    borderRadius: 999,
    height: 34,
    justifyContent: "center",
    marginTop: 8,
    width: 34
  },
  stepEditorBadgeText: {
    color: appColors.accent,
    fontSize: 14,
    fontWeight: "800",
    lineHeight: 18
  },
  stepEditorInput: {
    flex: 1,
    minHeight: 92
  },
  stepEditorList: {
    gap: 12
  },
  stepEditorRow: {
    alignItems: "flex-start",
    flexDirection: "row",
    gap: 10
  },
  stepToolButton: {
    alignItems: "center",
    backgroundColor: appColors.accentSoft,
    borderRadius: 999,
    flexDirection: "row",
    gap: 6,
    minHeight: 36,
    paddingHorizontal: 12
  },
  stepToolButtonText: {
    color: appColors.accent,
    fontSize: 14,
    fontWeight: "700",
    lineHeight: 18
  },
  statusCard: {
    gap: 18
  },
  statusCopy: {
    gap: 8
  }
});
