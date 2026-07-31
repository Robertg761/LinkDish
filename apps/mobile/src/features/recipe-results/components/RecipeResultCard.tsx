import { MaterialCommunityIcons } from "@expo/vector-icons";
import {
  matchStepIngredients,
  parseIngredientQuantity,
  parseStepDurations,
  scaleQuantity
} from "@linkdish/recipe-domain";
import { AppButton, AppText } from "@linkdish/ui";
import { decodeHtmlEntities } from "@linkdish/utils";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import * as StoreReview from "expo-store-review";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  useWindowDimensions,
  View
} from "react-native";
import Reanimated, {
  Easing,
  FadeInDown,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withTiming
} from "react-native-reanimated";
import { SafeAreaView } from "react-native-safe-area-context";

import { trackMobileEvent } from "../../../analytics/client";
import { AppDialog } from "../../../components/AppDialog";
import { selectionTick, success } from "../../../lib/haptics";
import { buildProxiedRecipeImageUrl } from "../../../lib/recipeImage";
import {
  COOK_MODE_FINALE_DONE_LABEL,
  COOK_MODE_FINALE_TITLE,
  getCookModeFinaleBody,
  getIngredientCheckboxLabel
} from "../../../theme/flavorCopy";
import { pressedOpacity } from "../../../theme/interactions";
import { appColors } from "../../../theme/tokens";
import { buildRecipeMetaLine } from "../recipeMetaLine";

import type { Recipe } from "@linkdish/recipe-domain";
import type { GestureResponderEvent } from "react-native";

const COOK_MODE_KEEP_AWAKE_TAG = "linkdish-cook-mode";
const COOK_MODE_HINT_STORAGE_KEY = "linkdish.hasSeenCookModeHints";
const COOK_MODE_REVIEW_REQUESTED_STORAGE_KEY = "linkdish.reviewRequested.v1";
const COOK_MODE_SWIPE_HORIZONTAL_DOMINANCE = 1.15;
const COOK_MODE_SWIPE_THRESHOLD = 36;
const COOK_MODE_TAP_MOVEMENT_TOLERANCE = 10;
const COOK_MODE_STEP_TRANSITION_DURATION_MS = 170;
const COOK_MODE_INGREDIENTS_ANIMATION_DURATION_MS = 260;
const COOK_MODE_PROGRESS_DURATION_MS = 400;
const COOK_MODE_INGREDIENT_CHECK_DURATION_MS = 180;
const COOK_MODE_KEEP_AWAKE_PULSE_MS = 240;
const COOK_MODE_REVIEW_PROMPT_DELAY_MS = 1500;
const RESULT_CARD_ENTER_DURATION_MS = 260;
const TIMER_TICK_INTERVAL_MS = 1000;
const DEFAULT_CUSTOM_SCALE = 1.5;
const SCALE_OPTIONS = [0.5, 1, 2] as const;

type ScaleMode = "0.5" | "1" | "2" | "custom";
type UnitMode = "metric" | "original";
export type RecipeShoppingActionContext = {
  scaleFactor: number;
  unitMode: UnitMode;
};
type ParsedIngredientDisplay = ReturnType<typeof parseIngredientQuantity>;
type IngredientDisplay = {
  ingredientIndex: number;
  key: string;
  parsed: ParsedIngredientDisplay;
  text: string;
};
type IngredientGroup = {
  key: string;
  section: string | null;
  ingredients: IngredientDisplay[];
};
type CookStep = {
  durations: ReturnType<typeof parseStepDurations>;
  fallbackIndex: number;
  index: number;
  matchedIngredientIndexes: number[];
  sectionLabel: string | null;
  text: string;
};
type ActiveTimer = {
  completed: boolean;
  deadlineMs: number;
  id: string;
  label: string;
  totalSeconds: number;
};

const deactivateCookModeKeepAwake = () => {
  try {
    void Promise.resolve(deactivateKeepAwake(COOK_MODE_KEEP_AWAKE_TAG)).catch((error) => {
      console.warn("Failed to release cook mode keep awake.", error);
    });
  } catch (error) {
    console.warn("Failed to release cook mode keep awake.", error);
  }
};

const requestCookModeFinaleReview = async () => {
  try {
    const hasRequestedReview = await AsyncStorage.getItem(COOK_MODE_REVIEW_REQUESTED_STORAGE_KEY);

    if (hasRequestedReview === "true") {
      return;
    }

    const isAvailable = await StoreReview.isAvailableAsync();

    if (!isAvailable) {
      return;
    }

    await AsyncStorage.setItem(COOK_MODE_REVIEW_REQUESTED_STORAGE_KEY, "true");
    await StoreReview.requestReview();
  } catch {
    // In-app review is purely opportunistic; never interrupt the cook-mode finale.
  }
};

const nutritionRows = [
  ["Calories", "calories"],
  ["Protein", "protein"],
  ["Carbohydrates", "carbohydrates"],
  ["Fat", "fat"],
  ["Fiber", "fiber"],
  ["Sugar", "sugar"],
  ["Sodium", "sodium"]
] as const;

const decodeDisplayText = (value: string) => decodeHtmlEntities(value).replace(/\u00a0/gu, " ");

const SectionHeading = ({ action, label }: { action?: React.ReactNode; label: string }) => (
  <View style={styles.sectionHeading}>
    <View style={styles.sectionLabelLine}>
      <AppText tone="accent" variant="label">
        {label}
      </AppText>
      <View style={styles.sectionRule} />
    </View>
    {action}
  </View>
);

const CookModeHintCard = ({ onDismiss }: { onDismiss: () => void }) => (
  <View style={styles.cookModeHintCard}>
    <View style={styles.cookModeHintLine}>
      <AppText style={styles.cookModeHintIcon}>← →</AppText>
      <AppText style={styles.cookModeHintText}>Tap the sides to move through steps.</AppText>
    </View>
    <View style={styles.cookModeHintLine}>
      <MaterialCommunityIcons color={appColors.accent} name="check" size={16} />
      <AppText style={styles.cookModeHintText}>Tap ingredients to check them off.</AppText>
    </View>
    <AppButton label="Got it" onPress={onDismiss} style={styles.cookModeHintDismiss} />
  </View>
);

const isDeliberateHorizontalCookModeSwipe = (
  deltaX: number,
  deltaY: number,
  minimumDistance: number
): boolean => {
  const absoluteX = Math.abs(deltaX);
  const absoluteY = Math.abs(deltaY);

  return (
    absoluteX >= minimumDistance && absoluteX >= absoluteY * COOK_MODE_SWIPE_HORIZONTAL_DOMINANCE
  );
};

const normalizeIngredientSection = (section: string | null | undefined): string | null => {
  const normalized = section?.trim();
  return normalized ? decodeDisplayText(normalized) : null;
};

const normalizeMethodSection = (section: string | null | undefined): string | null => {
  const normalized = section?.trim();
  return normalized ? decodeDisplayText(normalized) : null;
};

const getMethodSectionHeading = (text: string): string | null => {
  const match = text.match(/^#?\s*([^:#][^:]{0,80}):$/u);
  const heading = match?.[1]?.trim();
  return heading ? decodeDisplayText(heading) : null;
};

const groupIngredients = (ingredients: Recipe["ingredients"]) => {
  const groups: IngredientGroup[] = [];

  ingredients.forEach((ingredient, index) => {
    const section = normalizeIngredientSection(ingredient.section);
    const text = decodeDisplayText(ingredient.text);
    const currentGroup = groups[groups.length - 1];

    if (!currentGroup || currentGroup.section !== section) {
      groups.push({
        key: `${section ?? "ungrouped"}-${index}`,
        section,
        ingredients: []
      });
    }

    groups[groups.length - 1]?.ingredients.push({
      key: `${index}-${text}`,
      ingredientIndex: index,
      parsed: parseIngredientQuantity(text),
      text
    });
  });

  return groups;
};

const getScaleFactor = (scaleMode: ScaleMode, customScale: number): number => {
  if (scaleMode === "custom") {
    return customScale;
  }

  return Number(scaleMode);
};

const hasMetricAlternative = (ingredientGroups: IngredientGroup[]): boolean =>
  ingredientGroups.some((group) =>
    group.ingredients.some(
      (ingredient) => ingredient.parsed.confident && ingredient.parsed.altQty != null
    )
  );

const hasUnscalableIngredient = (ingredientGroups: IngredientGroup[]): boolean =>
  ingredientGroups.some((group) =>
    group.ingredients.some((ingredient) => !ingredient.parsed.confident)
  );

const getScaledIngredientText = (
  ingredient: IngredientDisplay,
  scaleFactor: number,
  unitMode: UnitMode
): string => {
  if (!ingredient.parsed.confident) {
    return ingredient.text;
  }

  if (unitMode === "metric" && ingredient.parsed.altQty != null && ingredient.parsed.altUnit) {
    return scaleQuantity(
      {
        ...ingredient.parsed,
        altQty: null,
        altUnit: null,
        qty: ingredient.parsed.altQty,
        unit: ingredient.parsed.altUnit
      },
      scaleFactor
    );
  }

  if (scaleFactor === 1 && unitMode === "original") {
    return ingredient.text;
  }

  return scaleQuantity(ingredient.parsed, scaleFactor);
};

export const getTimerRemainingSeconds = (deadlineMs: number, nowMs: number): number =>
  Math.max(0, Math.ceil((deadlineMs - nowMs) / 1000));

const formatTimerRemaining = (remainingSeconds: number): string => {
  const minutes = Math.floor(remainingSeconds / 60);
  const seconds = remainingSeconds % 60;

  return `${minutes}:${String(seconds).padStart(2, "0")}`;
};

const formatScaleLabel = (scaleFactor: number): string =>
  `${Number.isInteger(scaleFactor) ? scaleFactor.toFixed(0) : scaleFactor.toFixed(1)}x`;

const CookModeIngredientRow = ({
  checked,
  ingredient,
  onToggle,
  text
}: {
  checked: boolean;
  ingredient: IngredientDisplay;
  onToggle: (key: string) => void;
  text: string;
}) => {
  const checkedProgress = useRef(new Animated.Value(checked ? 1 : 0)).current;

  useEffect(() => {
    Animated.timing(checkedProgress, {
      duration: COOK_MODE_INGREDIENT_CHECK_DURATION_MS,
      toValue: checked ? 1 : 0,
      useNativeDriver: false
    }).start();
  }, [checked, checkedProgress]);

  const textColor = checkedProgress.interpolate({
    inputRange: [0, 1],
    outputRange: [appColors.text, appColors.muted]
  });
  const strikeOpacity = checkedProgress.interpolate({
    inputRange: [0, 1],
    outputRange: [0, 1]
  });

  return (
    <Pressable
      accessibilityLabel={getIngredientCheckboxLabel(ingredient.text)}
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      onPress={() => onToggle(ingredient.key)}
      style={({ pressed }) => [
        styles.cookModeIngredientRow,
        pressed && styles.cookModeIngredientRowPressed
      ]}
    >
      <View
        style={[styles.cookModeIngredientCheck, checked && styles.cookModeIngredientCheckChecked]}
      >
        {checked ? (
          <MaterialCommunityIcons color={appColors.canvas} name="check" size={13} />
        ) : null}
      </View>
      <View style={styles.cookModeIngredientTextWrap}>
        <Animated.Text
          style={[
            styles.cookModeIngredientText,
            { color: textColor },
            checked && styles.cookModeIngredientTextChecked
          ]}
        >
          {text}
        </Animated.Text>
        <Animated.View
          pointerEvents="none"
          style={[styles.cookModeIngredientStrike, { opacity: strikeOpacity }]}
        />
      </View>
    </Pressable>
  );
};

const ServingsScaleControls = ({
  customScale,
  hasAltUnits,
  onCustomScaleChange,
  onScaleModeChange,
  onUnitModeChange,
  scaleMode,
  unitMode
}: {
  customScale: number;
  hasAltUnits: boolean;
  onCustomScaleChange: (scale: number) => void;
  onScaleModeChange: (mode: ScaleMode) => void;
  onUnitModeChange: (mode: UnitMode) => void;
  scaleMode: ScaleMode;
  unitMode: UnitMode;
}) => {
  const decrementCustomScale = () => {
    onScaleModeChange("custom");
    onCustomScaleChange(Math.max(0.5, Number((customScale - 0.5).toFixed(1))));
  };
  const incrementCustomScale = () => {
    onScaleModeChange("custom");
    onCustomScaleChange(Math.min(6, Number((customScale + 0.5).toFixed(1))));
  };

  return (
    <View style={styles.scalePanel}>
      <View style={styles.scaleHeaderRow}>
        <AppText tone="accent" variant="label">
          Servings
        </AppText>
      </View>
      <View style={styles.scaleOptionRow}>
        {SCALE_OPTIONS.map((option) => {
          const optionMode = String(option) as ScaleMode;
          const selected = scaleMode === optionMode;

          return (
            <Pressable
              accessibilityLabel={`Scale recipe to ${formatScaleLabel(option)}`}
              accessibilityRole="button"
              key={option}
              onPress={() => onScaleModeChange(optionMode)}
              style={({ pressed }) => [
                styles.scaleOption,
                selected && styles.scaleOptionSelected,
                pressed && styles.pressed
              ]}
            >
              <AppText style={[styles.scaleOptionText, selected && styles.scaleOptionTextSelected]}>
                {formatScaleLabel(option)}
              </AppText>
            </Pressable>
          );
        })}
        <Pressable
          accessibilityLabel="Use custom recipe scale"
          accessibilityRole="button"
          onPress={() => onScaleModeChange("custom")}
          style={({ pressed }) => [
            styles.scaleOption,
            scaleMode === "custom" && styles.scaleOptionSelected,
            pressed && styles.pressed
          ]}
        >
          <AppText
            style={[
              styles.scaleOptionText,
              scaleMode === "custom" && styles.scaleOptionTextSelected
            ]}
          >
            Custom
          </AppText>
        </Pressable>
      </View>
      {scaleMode === "custom" ? (
        <View style={styles.customScaleRow}>
          <Pressable
            accessibilityLabel="Decrease custom recipe scale"
            accessibilityRole="button"
            onPress={decrementCustomScale}
            style={({ pressed }) => [styles.customScaleButton, pressed && styles.pressed]}
          >
            <MaterialCommunityIcons color={appColors.accent} name="minus" size={18} />
          </Pressable>
          <AppText style={styles.customScaleValue}>{formatScaleLabel(customScale)}</AppText>
          <Pressable
            accessibilityLabel="Increase custom recipe scale"
            accessibilityRole="button"
            onPress={incrementCustomScale}
            style={({ pressed }) => [styles.customScaleButton, pressed && styles.pressed]}
          >
            <MaterialCommunityIcons color={appColors.accent} name="plus" size={18} />
          </Pressable>
        </View>
      ) : null}
      {hasAltUnits ? (
        <View style={styles.unitToggleRow}>
          {(["original", "metric"] as const).map((mode) => {
            const selected = unitMode === mode;

            return (
              <Pressable
                accessibilityLabel={`Show ${mode === "metric" ? "metric" : "original"} ingredient units`}
                accessibilityRole="button"
                key={mode}
                onPress={() => onUnitModeChange(mode)}
                style={({ pressed }) => [
                  styles.unitToggleOption,
                  selected && styles.unitToggleOptionSelected,
                  pressed && styles.pressed
                ]}
              >
                <AppText style={[styles.unitToggleText, selected && styles.unitToggleTextSelected]}>
                  {mode === "metric" ? "Metric" : "Original"}
                </AppText>
              </Pressable>
            );
          })}
        </View>
      ) : null}
    </View>
  );
};

export const RecipeResultCard = ({
  actionSlot,
  eyebrowLabel = "Recipe Preview",
  onAddIngredientsToShoppingList,
  onCookModeFinish,
  notes,
  recipe
}: {
  actionSlot?: React.ReactNode | ((context: RecipeShoppingActionContext) => React.ReactNode);
  eyebrowLabel?: "Recipe" | "Recipe Preview";
  onAddIngredientsToShoppingList?: (context: RecipeShoppingActionContext) => void;
  onCookModeFinish?: () => void | Promise<void>;
  notes?: string | undefined;
  recipe: Recipe;
}) => {
  const [isCookingModeVisible, setIsCookingModeVisible] = useState(false);
  const [isNutritionExpanded, setIsNutritionExpanded] = useState(true);
  const [scaleMode, setScaleMode] = useState<ScaleMode>("1");
  const [customScale, setCustomScale] = useState(DEFAULT_CUSTOM_SCALE);
  const [unitMode, setUnitMode] = useState<UnitMode>("original");
  const windowDimensions = useWindowDimensions();
  const decodedTitle = decodeDisplayText(recipe.title);
  const decodedNotes = notes?.trim() ? decodeDisplayText(notes.trim()) : null;
  const recipeMetaLine = buildRecipeMetaLine(recipe);
  const heroImageUrl = buildProxiedRecipeImageUrl(recipe.image, 480);
  const heroImageHeight = Math.min(windowDimensions.width * 0.62, windowDimensions.height * 0.38);
  const ingredientGroups = useMemo(
    () => groupIngredients(recipe.ingredients),
    [recipe.ingredients]
  );
  const flatIngredients = useMemo(
    () => ingredientGroups.flatMap((group) => group.ingredients),
    [ingredientGroups]
  );
  const scaleFactor = getScaleFactor(scaleMode, customScale);
  const hasAltUnits = hasMetricAlternative(ingredientGroups);
  const hasScalingHonestyNote = scaleFactor !== 1 && hasUnscalableIngredient(ingredientGroups);
  const shoppingActionContext = useMemo(
    () => ({
      scaleFactor,
      unitMode
    }),
    [scaleFactor, unitMode]
  );
  const renderedActionSlot =
    typeof actionSlot === "function" ? actionSlot(shoppingActionContext) : actionSlot;

  useEffect(() => {
    if (!hasAltUnits && unitMode !== "original") {
      setUnitMode("original");
    }
  }, [hasAltUnits, unitMode]);

  const decodedSteps = useMemo(() => {
    const steps: CookStep[] = [];
    let currentSection: string | null = null;
    let pendingSection: string | null = null;

    recipe.steps.forEach((step, index) => {
      const text = decodeDisplayText(step.text).trim();
      const runtimeSection = normalizeMethodSection(
        (step as Recipe["steps"][number] & { section?: string | null }).section
      );

      if (runtimeSection) {
        pendingSection = runtimeSection;
      }

      const heading = getMethodSectionHeading(text);

      if (heading) {
        pendingSection = heading;
        return;
      }

      if (!text) {
        return;
      }

      const sectionLabel =
        pendingSection && pendingSection !== currentSection ? pendingSection : null;

      if (sectionLabel) {
        currentSection = sectionLabel;
      }

      pendingSection = null;
      steps.push({
        durations: parseStepDurations(text),
        fallbackIndex: index + 1,
        index: steps.length + 1,
        matchedIngredientIndexes: matchStepIngredients(text, flatIngredients),
        sectionLabel,
        text
      });
    });

    return steps;
  }, [flatIngredients, recipe.steps]);

  return (
    <Reanimated.View
      entering={FadeInDown.duration(RESULT_CARD_ENTER_DURATION_MS)
        .easing(Easing.out(Easing.cubic))
        .withInitialValues({ opacity: 0, transform: [{ translateY: 8 }, { scale: 0.985 }] })
        .reduceMotion(ReduceMotion.System)}
      style={styles.container}
    >
      <View style={styles.hero}>
        {heroImageUrl ? (
          <Image
            accessibilityIgnoresInvertColors
            resizeMode="cover"
            source={{ uri: heroImageUrl }}
            style={[styles.heroImage, { height: heroImageHeight }]}
          />
        ) : null}
        <AppText style={styles.previewLabel} tone="accent" variant="label">
          {eyebrowLabel}
        </AppText>
        <AppText style={styles.recipeTitle} variant="headline">
          {decodedTitle}
        </AppText>

        <AppText muted style={styles.recipeMetaLine}>
          {recipeMetaLine}
        </AppText>
        <ServingsScaleControls
          customScale={customScale}
          hasAltUnits={hasAltUnits}
          onCustomScaleChange={setCustomScale}
          onScaleModeChange={setScaleMode}
          onUnitModeChange={setUnitMode}
          scaleMode={scaleMode}
          unitMode={unitMode}
        />
        {hasScalingHonestyNote ? (
          <AppText muted style={styles.scalingHonestyNote}>
            Some ingredients can't be scaled automatically and stay as written.
          </AppText>
        ) : null}
      </View>

      {renderedActionSlot ? <View style={styles.actionSlot}>{renderedActionSlot}</View> : null}

      <View style={styles.section}>
        <SectionHeading label="Ingredients" />
        <View style={styles.list}>
          {ingredientGroups.map((group) => (
            <View key={group.key} style={styles.ingredientGroup}>
              {group.section ? (
                <AppText style={styles.ingredientSection}>{group.section}</AppText>
              ) : null}
              {group.ingredients.map((ingredient) => (
                <View key={ingredient.key} style={styles.ingredientRow}>
                  <View style={styles.bullet} />
                  <AppText style={styles.listText}>
                    {getScaledIngredientText(ingredient, scaleFactor, unitMode)}
                  </AppText>
                </View>
              ))}
            </View>
          ))}
        </View>
      </View>

      <View style={styles.section}>
        <SectionHeading
          label="Method"
          action={
            decodedSteps.length > 0 ? (
              <Pressable
                accessibilityLabel="Open step-by-step cooking mode"
                accessibilityRole="button"
                onPress={() => setIsCookingModeVisible(true)}
                style={({ pressed }) => [styles.cookModeButton, pressed && styles.pressed]}
              >
                <MaterialCommunityIcons color={appColors.accent} name="chef-hat" size={18} />
                <AppText style={styles.cookModeButtonText}>Cook mode</AppText>
              </Pressable>
            ) : undefined
          }
        />
        <View style={styles.list}>
          {decodedSteps.map((step) => (
            <View key={`${step.index}-${step.fallbackIndex}`} style={styles.methodStepGroup}>
              {step.sectionLabel ? (
                <AppText style={styles.methodSection}>{step.sectionLabel}</AppText>
              ) : null}
              <View style={styles.stepRow}>
                <View style={styles.stepIndex}>
                  <AppText style={styles.stepIndexText} variant="title">
                    {String(step.index)}
                  </AppText>
                </View>
                <AppText style={styles.listText}>{step.text}</AppText>
              </View>
            </View>
          ))}
        </View>
      </View>

      {decodedNotes ? (
        <View style={styles.section}>
          <SectionHeading label="Personal Notes" />
          <AppText>{decodedNotes}</AppText>
        </View>
      ) : null}

      {recipe.nutrition ? (
        <View style={styles.section}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={isNutritionExpanded ? "Collapse nutrition" : "Expand nutrition"}
            onPress={() => setIsNutritionExpanded((expanded) => !expanded)}
            style={({ pressed }) => [pressed && styles.pressed]}
          >
            <SectionHeading
              label="Nutrition"
              action={
                <MaterialCommunityIcons
                  color={appColors.accent}
                  name={isNutritionExpanded ? "chevron-up" : "chevron-down"}
                  size={22}
                />
              }
            />
          </Pressable>
          {isNutritionExpanded ? (
            <View style={styles.metaGrid}>
              {nutritionRows
                .filter(([, key]) => recipe.nutrition?.[key] != null)
                .map(([label, key]) => (
                  <View key={key} style={styles.metaRow}>
                    <AppText muted style={styles.metaLabel}>
                      {label}
                    </AppText>
                    <AppText style={styles.metaValue}>
                      {decodeDisplayText(recipe.nutrition?.[key] ?? "")}
                    </AppText>
                  </View>
                ))}
            </View>
          ) : null}
        </View>
      ) : null}

      <CookingModeModal
        onClose={() => setIsCookingModeVisible(false)}
        customScale={customScale}
        flatIngredients={flatIngredients}
        hasAltUnits={hasAltUnits}
        hasScalingHonestyNote={hasScalingHonestyNote}
        ingredientGroups={ingredientGroups}
        onCustomScaleChange={setCustomScale}
        onAddIngredientsToShoppingList={
          onAddIngredientsToShoppingList
            ? () => onAddIngredientsToShoppingList(shoppingActionContext)
            : undefined
        }
        onCookModeFinish={onCookModeFinish}
        onScaleModeChange={setScaleMode}
        onUnitModeChange={setUnitMode}
        recipeTitle={decodedTitle}
        scaleFactor={scaleFactor}
        scaleMode={scaleMode}
        steps={decodedSteps}
        unitMode={unitMode}
        visible={isCookingModeVisible}
      />
    </Reanimated.View>
  );
};

const CookingModeModal = ({
  customScale,
  flatIngredients,
  hasAltUnits,
  hasScalingHonestyNote,
  ingredientGroups,
  onAddIngredientsToShoppingList,
  onClose,
  onCookModeFinish,
  onCustomScaleChange,
  onScaleModeChange,
  onUnitModeChange,
  recipeTitle,
  scaleFactor,
  scaleMode,
  steps,
  unitMode,
  visible
}: {
  customScale: number;
  flatIngredients: IngredientDisplay[];
  hasAltUnits: boolean;
  hasScalingHonestyNote: boolean;
  ingredientGroups: IngredientGroup[];
  onAddIngredientsToShoppingList?: (() => void) | undefined;
  onClose: () => void;
  onCookModeFinish?: (() => void | Promise<void>) | undefined;
  onCustomScaleChange: (scale: number) => void;
  onScaleModeChange: (mode: ScaleMode) => void;
  onUnitModeChange: (mode: UnitMode) => void;
  recipeTitle: string;
  scaleFactor: number;
  scaleMode: ScaleMode;
  steps: CookStep[];
  unitMode: UnitMode;
  visible: boolean;
}) => {
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [keepAwake, setKeepAwake] = useState(true);
  const [transitionDirection, setTransitionDirection] = useState<1 | -1>(1);
  const [isStepTransitionAnimating, setIsStepTransitionAnimating] = useState(false);
  const [isIngredientsExpanded, setIsIngredientsExpanded] = useState(false);
  const [checkedIngredientKeys, setCheckedIngredientKeys] = useState<Set<string>>(() => new Set());
  const [isFinaleVisible, setIsFinaleVisible] = useState(false);
  const [activeTimers, setActiveTimers] = useState<ActiveTimer[]>([]);
  const [areHintsVisible, setAreHintsVisible] = useState(false);
  const [isLeaveConfirmationVisible, setIsLeaveConfirmationVisible] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const currentStep = steps[currentStepIndex];
  const isFirstStep = currentStepIndex === 0;
  const isLastStep = currentStepIndex === steps.length - 1;
  const progressPercent = isFinaleVisible
    ? 100
    : steps.length > 0
      ? ((currentStepIndex + 1) / steps.length) * 100
      : 0;
  const stepTouchStartRef = useRef<{ x: number; y: number } | null>(null);
  const stepTapGestureRef = useRef<{ hasMoved: boolean; x: number; y: number } | null>(null);
  const stepTransition = useRef(new Animated.Value(0)).current;
  const progressFill = useSharedValue(progressPercent);
  const ingredientsReveal = useSharedValue(0);
  const keepAwakePulse = useSharedValue(0);
  const activeTimerPulse = useSharedValue(0);
  const isStepTransitionAnimatingRef = useRef(false);
  const activeStepTransitionRef = useRef<ReturnType<typeof Animated.timing> | null>(null);
  const stepTransitionGenerationRef = useRef(0);
  const cookModeStartedAtRef = useRef<number | null>(null);
  const hasTrackedCookModeCompletionRef = useRef(false);
  const scrollRef = useRef<ScrollView>(null);
  const { width: modalWidth } = useWindowDimensions();
  const runningTimerCount = activeTimers.filter(
    (timer) => !timer.completed && getTimerRemainingSeconds(timer.deadlineMs, nowMs) > 0
  ).length;

  const invalidateStepTransition = useCallback(() => {
    stepTransitionGenerationRef.current += 1;
    activeStepTransitionRef.current?.stop();
    activeStepTransitionRef.current = null;
    isStepTransitionAnimatingRef.current = false;
    stepTouchStartRef.current = null;
    stepTapGestureRef.current = null;
    stepTransition.setValue(0);
  }, [stepTransition]);

  const cancelStepTransition = useCallback(() => {
    invalidateStepTransition();
    setIsStepTransitionAnimating(false);
  }, [invalidateStepTransition]);

  useEffect(
    () => () => {
      invalidateStepTransition();
    },
    [invalidateStepTransition]
  );

  useEffect(() => {
    scrollRef.current?.scrollTo({ y: 0, animated: false });
  }, [currentStepIndex, isFinaleVisible]);

  useEffect(() => {
    if (!visible || !isFinaleVisible) {
      return;
    }

    const timeoutId = setTimeout(() => {
      void requestCookModeFinaleReview();
    }, COOK_MODE_REVIEW_PROMPT_DELAY_MS);

    return () => {
      clearTimeout(timeoutId);
    };
  }, [isFinaleVisible, visible]);

  useEffect(() => {
    cancelStepTransition();

    if (visible) {
      cookModeStartedAtRef.current = Date.now();
      hasTrackedCookModeCompletionRef.current = false;
      trackMobileEvent({
        eventName: "cook_mode_started",
        routeOrScreen: "recipe",
        properties: {
          entry_point: "recipe_detail",
          step_count: steps.length
        }
      });
      setCurrentStepIndex(0);
      setIsIngredientsExpanded(false);
      setCheckedIngredientKeys(new Set());
      setIsFinaleVisible(false);
      setKeepAwake(true);
      setActiveTimers([]);
      setNowMs(Date.now());
      ingredientsReveal.value = 0;
      keepAwakePulse.value = 0;

      void (async () => {
        try {
          const storedValue = await AsyncStorage.getItem(COOK_MODE_HINT_STORAGE_KEY);

          if (storedValue !== "true") {
            setAreHintsVisible(true);
          }
        } catch (error) {
          console.warn("Failed to load cook mode hint state.", error);
        }
      })();
    }
  }, [cancelStepTransition, ingredientsReveal, keepAwakePulse, steps.length, visible]);

  useEffect(() => {
    if (!visible || !isFinaleVisible || hasTrackedCookModeCompletionRef.current) {
      return;
    }

    hasTrackedCookModeCompletionRef.current = true;
    const startedAt = cookModeStartedAtRef.current;
    trackMobileEvent({
      eventName: "cook_mode_completed",
      routeOrScreen: "recipe",
      properties: {
        ...(startedAt
          ? { elapsed_seconds: Math.max(0, Math.round((Date.now() - startedAt) / 1000)) }
          : {}),
        step_count: steps.length
      }
    });
    void Promise.resolve(onCookModeFinish?.()).catch((error: unknown) => {
      console.warn("Failed to record cook mode completion.", error);
    });
  }, [isFinaleVisible, onCookModeFinish, steps.length, visible]);

  const dismissHints = useCallback(() => {
    setAreHintsVisible(false);

    void AsyncStorage.setItem(COOK_MODE_HINT_STORAGE_KEY, "true").catch((error) => {
      console.warn("Failed to persist cook mode hint state.", error);
    });
  }, []);

  useEffect(() => {
    if (!visible || activeTimers.length === 0) {
      return;
    }

    const intervalId = setInterval(() => {
      setNowMs(Date.now());
    }, TIMER_TICK_INTERVAL_MS);

    return () => {
      clearInterval(intervalId);
    };
  }, [activeTimers.length, visible]);

  useEffect(() => {
    const newlyCompletedTimers = activeTimers.filter(
      (timer) => !timer.completed && getTimerRemainingSeconds(timer.deadlineMs, nowMs) <= 0
    );

    if (newlyCompletedTimers.length === 0) {
      return;
    }

    newlyCompletedTimers.forEach(() => success());
    activeTimerPulse.value = 0;
    activeTimerPulse.value = withTiming(1, {
      duration: 420,
      easing: Easing.out(Easing.cubic),
      reduceMotion: ReduceMotion.System
    });
    setActiveTimers((currentTimers) =>
      currentTimers.map((timer) =>
        newlyCompletedTimers.some((completedTimer) => completedTimer.id === timer.id)
          ? { ...timer, completed: true }
          : timer
      )
    );
  }, [activeTimerPulse, activeTimers, nowMs]);

  useEffect(() => {
    ingredientsReveal.value = withTiming(isIngredientsExpanded ? 1 : 0, {
      duration: COOK_MODE_INGREDIENTS_ANIMATION_DURATION_MS,
      easing: Easing.out(Easing.cubic),
      reduceMotion: ReduceMotion.System
    });
  }, [ingredientsReveal, isIngredientsExpanded]);

  useEffect(() => {
    progressFill.value = withTiming(progressPercent, {
      duration: COOK_MODE_PROGRESS_DURATION_MS,
      easing: Easing.bezier(0.22, 1, 0.36, 1),
      reduceMotion: ReduceMotion.System
    });
  }, [progressFill, progressPercent]);

  const toggleIngredientsExpanded = useCallback(() => {
    setIsIngredientsExpanded((expanded) => !expanded);
  }, []);

  const toggleIngredientChecked = useCallback((ingredientKey: string) => {
    selectionTick();
    setCheckedIngredientKeys((current) => {
      const next = new Set(current);

      if (next.has(ingredientKey)) {
        next.delete(ingredientKey);
      } else {
        next.add(ingredientKey);
      }

      return next;
    });
  }, []);

  const startTimer = useCallback(
    (duration: CookStep["durations"][number], durationIndex: number) => {
      selectionTick();
      const startedAtMs = Date.now();
      const timerId = `${currentStep?.fallbackIndex ?? currentStepIndex}-${durationIndex}-${startedAtMs}`;

      setNowMs(startedAtMs);
      setActiveTimers((currentTimers) => [
        ...currentTimers,
        {
          completed: false,
          deadlineMs: startedAtMs + duration.maxSeconds * 1000,
          id: timerId,
          label: duration.label,
          totalSeconds: duration.maxSeconds
        }
      ]);
    },
    [currentStep?.fallbackIndex, currentStepIndex]
  );

  const dismissTimer = useCallback((timerId: string) => {
    setActiveTimers((currentTimers) => currentTimers.filter((timer) => timer.id !== timerId));
  }, []);

  const confirmCloseWithTimers = useCallback(() => {
    setIsLeaveConfirmationVisible(true);
  }, []);

  const closeCookMode = useCallback(() => {
    cancelStepTransition();
    onClose();
  }, [cancelStepTransition, onClose]);

  const handleRequestClose = useCallback(() => {
    if (runningTimerCount > 0) {
      confirmCloseWithTimers();
      return;
    }

    closeCookMode();
  }, [closeCookMode, confirmCloseWithTimers, runningTimerCount]);

  useEffect(() => {
    if (!keepAwake) {
      keepAwakePulse.value = 0;
      return;
    }

    keepAwakePulse.value = 0;
    keepAwakePulse.value = withTiming(1, {
      duration: COOK_MODE_KEEP_AWAKE_PULSE_MS,
      easing: Easing.out(Easing.cubic),
      reduceMotion: ReduceMotion.System
    });
  }, [keepAwake, keepAwakePulse]);

  useEffect(() => {
    if (!visible || !keepAwake) {
      deactivateCookModeKeepAwake();
      return;
    }

    void activateKeepAwakeAsync(COOK_MODE_KEEP_AWAKE_TAG).catch((error) => {
      console.warn("Failed to keep the screen awake.", error);
    });

    return () => {
      deactivateCookModeKeepAwake();
    };
  }, [keepAwake, visible]);

  const animateToStep = useCallback(
    (nextStepIndex: number, direction: 1 | -1) => {
      if (
        isStepTransitionAnimatingRef.current ||
        nextStepIndex === currentStepIndex ||
        nextStepIndex < 0 ||
        nextStepIndex >= steps.length
      ) {
        return;
      }

      selectionTick();
      const transitionGeneration = stepTransitionGenerationRef.current + 1;
      stepTransitionGenerationRef.current = transitionGeneration;
      isStepTransitionAnimatingRef.current = true;
      setIsStepTransitionAnimating(true);
      setTransitionDirection(direction);
      stepTransition.setValue(0);

      const completeTransition = () => {
        if (stepTransitionGenerationRef.current !== transitionGeneration) {
          return;
        }

        activeStepTransitionRef.current = null;
        isStepTransitionAnimatingRef.current = false;
        setIsStepTransitionAnimating(false);
        stepTransition.setValue(0);
      };

      const exitAnimation = Animated.timing(stepTransition, {
        duration: COOK_MODE_STEP_TRANSITION_DURATION_MS,
        toValue: 1,
        useNativeDriver: true
      });
      activeStepTransitionRef.current = exitAnimation;
      exitAnimation.start(({ finished }) => {
        if (stepTransitionGenerationRef.current !== transitionGeneration) {
          return;
        }

        if (!finished) {
          completeTransition();
          return;
        }

        setCurrentStepIndex(nextStepIndex);
        stepTransition.setValue(-1);

        const enterAnimation = Animated.timing(stepTransition, {
          duration: COOK_MODE_STEP_TRANSITION_DURATION_MS,
          toValue: 0,
          useNativeDriver: true
        });
        activeStepTransitionRef.current = enterAnimation;
        enterAnimation.start(() => {
          completeTransition();
        });
      });
    },
    [currentStepIndex, stepTransition, steps.length]
  );

  const goToPreviousStep = useCallback(() => {
    if (isStepTransitionAnimatingRef.current) {
      return;
    }

    dismissHints();
    animateToStep(currentStepIndex - 1, -1);
  }, [animateToStep, currentStepIndex, dismissHints]);

  const goToNextStep = useCallback(() => {
    if (isStepTransitionAnimatingRef.current) {
      return;
    }

    dismissHints();

    if (isLastStep) {
      selectionTick();
      setIsFinaleVisible(true);
      return;
    }

    animateToStep(currentStepIndex + 1, 1);
  }, [animateToStep, currentStepIndex, dismissHints, isLastStep]);

  const handleStepTouchStart = useCallback((event: GestureResponderEvent) => {
    if (isStepTransitionAnimatingRef.current) {
      stepTouchStartRef.current = null;
      return;
    }

    stepTouchStartRef.current = {
      x: event.nativeEvent.pageX,
      y: event.nativeEvent.pageY
    };
  }, []);

  const handleStepTapPressIn = useCallback((event: GestureResponderEvent) => {
    stepTapGestureRef.current = {
      hasMoved: false,
      x: event.nativeEvent.pageX,
      y: event.nativeEvent.pageY
    };
  }, []);

  const handleStepTapPressMove = useCallback((event: GestureResponderEvent) => {
    const gesture = stepTapGestureRef.current;

    if (!gesture || gesture.hasMoved) {
      return;
    }

    if (
      Math.abs(event.nativeEvent.pageX - gesture.x) > COOK_MODE_TAP_MOVEMENT_TOLERANCE ||
      Math.abs(event.nativeEvent.pageY - gesture.y) > COOK_MODE_TAP_MOVEMENT_TOLERANCE
    ) {
      gesture.hasMoved = true;
    }
  }, []);

  const consumeStationaryStepTap = useCallback((event: GestureResponderEvent) => {
    const gesture = stepTapGestureRef.current;
    stepTapGestureRef.current = null;

    if (!gesture) {
      return true;
    }

    return (
      !gesture.hasMoved &&
      Math.abs(event.nativeEvent.pageX - gesture.x) <= COOK_MODE_TAP_MOVEMENT_TOLERANCE &&
      Math.abs(event.nativeEvent.pageY - gesture.y) <= COOK_MODE_TAP_MOVEMENT_TOLERANCE
    );
  }, []);

  const handlePreviousStepTap = useCallback(
    (event: GestureResponderEvent) => {
      if (consumeStationaryStepTap(event) && !isFirstStep) {
        goToPreviousStep();
      }
    },
    [consumeStationaryStepTap, goToPreviousStep, isFirstStep]
  );

  const handleNextStepTap = useCallback(
    (event: GestureResponderEvent) => {
      if (consumeStationaryStepTap(event)) {
        goToNextStep();
      }
    },
    [consumeStationaryStepTap, goToNextStep]
  );

  const handleStepTouchEnd = useCallback(
    (event: GestureResponderEvent) => {
      const touchStart = stepTouchStartRef.current;
      stepTouchStartRef.current = null;

      if (!touchStart || isStepTransitionAnimatingRef.current) {
        return;
      }

      const deltaX = event.nativeEvent.pageX - touchStart.x;
      const deltaY = event.nativeEvent.pageY - touchStart.y;

      if (!isDeliberateHorizontalCookModeSwipe(deltaX, deltaY, COOK_MODE_SWIPE_THRESHOLD)) {
        return;
      }

      if (deltaX < 0) {
        if (!isFinaleVisible) {
          goToNextStep();
        }
        return;
      }

      if (isFinaleVisible) {
        selectionTick();
        setCurrentStepIndex(Math.max(0, steps.length - 1));
        setIsFinaleVisible(false);
        return;
      }

      goToPreviousStep();
    },
    [goToNextStep, goToPreviousStep, isFinaleVisible, steps.length]
  );

  const stepAnimatedStyle = {
    opacity: stepTransition.interpolate({
      inputRange: [-1, 0, 1],
      outputRange: [0, 1, 0.2]
    }),
    transform: [
      { perspective: 900 },
      {
        translateX: stepTransition.interpolate({
          inputRange: [-1, 0, 1],
          outputRange: [transitionDirection * 44, 0, transitionDirection * -44]
        })
      },
      {
        rotateY: stepTransition.interpolate({
          inputRange: [-1, 0, 1],
          outputRange: [`${transitionDirection * -18}deg`, "0deg", `${transitionDirection * 18}deg`]
        })
      }
    ]
  };

  const ingredientsChevronStyle = useAnimatedStyle(() => ({
    transform: [
      {
        rotate: `${ingredientsReveal.value * 180}deg`
      }
    ]
  }));

  const progressBarFillStyle = useAnimatedStyle(() => ({
    width: `${progressFill.value}%`
  }));

  const keepAwakeIconStyle = useAnimatedStyle(() => ({
    transform: [
      {
        rotate: `${keepAwakePulse.value * 45}deg`
      },
      {
        scale: keepAwake ? 1.06 - keepAwakePulse.value * 0.06 : 1
      }
    ]
  }));

  const activeTimerPulseStyle = useAnimatedStyle(() => ({
    opacity: 1 - activeTimerPulse.value * 0.08,
    transform: [
      {
        scale: 1 + activeTimerPulse.value * 0.015
      }
    ]
  }));

  const matchedCurrentStepIngredients = currentStep
    ? currentStep.matchedIngredientIndexes
        .map((ingredientIndex) => flatIngredients[ingredientIndex])
        .filter((ingredient): ingredient is IngredientDisplay => ingredient != null)
    : [];

  const renderCookModeIngredients = () => (
    <View style={styles.cookModeIngredientsContent}>
      <ServingsScaleControls
        customScale={customScale}
        hasAltUnits={hasAltUnits}
        onCustomScaleChange={onCustomScaleChange}
        onScaleModeChange={onScaleModeChange}
        onUnitModeChange={onUnitModeChange}
        scaleMode={scaleMode}
        unitMode={unitMode}
      />
      {hasScalingHonestyNote ? (
        <AppText muted style={styles.scalingHonestyNote}>
          Some ingredients can't be scaled automatically and stay as written.
        </AppText>
      ) : null}
      {ingredientGroups.map((group) => (
        <View key={group.key} style={styles.cookModeIngredientGroup}>
          {group.section ? (
            <AppText style={styles.cookModeIngredientSection}>{group.section}</AppText>
          ) : null}
          {group.ingredients.map((ingredient) => (
            <CookModeIngredientRow
              checked={checkedIngredientKeys.has(ingredient.key)}
              ingredient={ingredient}
              key={ingredient.key}
              onToggle={toggleIngredientChecked}
              text={getScaledIngredientText(ingredient, scaleFactor, unitMode)}
            />
          ))}
        </View>
      ))}
    </View>
  );

  const renderStepTimerChips = () =>
    currentStep && currentStep.durations.length > 0 ? (
      <View style={styles.stepTimerChipRow}>
        {currentStep.durations.map((duration, durationIndex) => (
          <Pressable
            accessibilityLabel={`Start ${duration.label} timer`}
            accessibilityRole="button"
            key={`${currentStep.fallbackIndex}-${durationIndex}-${duration.label}`}
            onPress={() => startTimer(duration, durationIndex)}
            style={({ pressed }) => [styles.stepTimerChip, pressed && styles.pressed]}
          >
            <AppText style={styles.stepTimerChipText}>{duration.label}</AppText>
            <MaterialCommunityIcons color={appColors.accent} name="play" size={14} />
          </Pressable>
        ))}
      </View>
    ) : null;

  const renderMatchedIngredientStrip = () =>
    matchedCurrentStepIngredients.length > 0 ? (
      <View style={styles.stepIngredientStrip}>
        {matchedCurrentStepIngredients.map((ingredient) => (
          <AppText muted key={ingredient.key} style={styles.stepIngredientLine}>
            {getScaledIngredientText(ingredient, scaleFactor, unitMode)}
          </AppText>
        ))}
      </View>
    ) : null;

  const renderActiveTimers = () =>
    activeTimers.length > 0 ? (
      <Reanimated.View style={[styles.activeTimerStack, activeTimerPulseStyle]}>
        {activeTimers.map((timer) => {
          const remainingSeconds = getTimerRemainingSeconds(timer.deadlineMs, nowMs);
          const completed = timer.completed || remainingSeconds <= 0;

          return (
            <Pressable
              accessibilityLabel={`Dismiss ${timer.label} timer`}
              accessibilityRole="button"
              key={timer.id}
              onPress={() => dismissTimer(timer.id)}
              style={({ pressed }) => [
                styles.activeTimerChip,
                completed && styles.activeTimerChipComplete,
                pressed && styles.pressed
              ]}
            >
              <MaterialCommunityIcons
                color={completed ? appColors.canvas : appColors.accent}
                name={completed ? "check" : "timer-outline"}
                size={14}
              />
              <AppText
                style={[
                  styles.activeTimerChipText,
                  completed && styles.activeTimerChipTextComplete
                ]}
              >
                {completed ? "Done" : formatTimerRemaining(remainingSeconds)}
              </AppText>
              <AppText
                numberOfLines={1}
                style={[styles.activeTimerLabel, completed && styles.activeTimerChipTextComplete]}
              >
                {timer.label}
              </AppText>
            </Pressable>
          );
        })}
      </Reanimated.View>
    ) : null;

  const renderCookModeFinale = () => (
    <View style={styles.cookModeFinaleCard}>
      <AppText italic style={styles.cookModeFinaleTitle} tone="accent" variant="display">
        {COOK_MODE_FINALE_TITLE}
      </AppText>
      <View style={styles.cookModeFinaleIcon}>
        <MaterialCommunityIcons color={appColors.accent} name="chef-hat" size={28} />
        <View style={styles.cookModeFinaleCheck}>
          <MaterialCommunityIcons color={appColors.canvas} name="check" size={12} />
        </View>
      </View>
      <AppText muted style={styles.cookModeFinaleBody}>
        {getCookModeFinaleBody(recipeTitle)}
      </AppText>
      {onAddIngredientsToShoppingList ? (
        <AppButton
          label="Add ingredients to shopping list"
          onPress={onAddIngredientsToShoppingList}
          style={styles.cookModeFinaleButton}
          variant="outline"
        />
      ) : null}
      <AppButton
        label={COOK_MODE_FINALE_DONE_LABEL}
        onPress={handleRequestClose}
        style={styles.cookModeFinaleButton}
      />
    </View>
  );

  return (
    <Modal
      animationType="slide"
      onRequestClose={handleRequestClose}
      presentationStyle="pageSheet"
      visible={visible}
    >
      <SafeAreaView style={styles.cookModeScreen}>
        <View style={styles.cookModeHeader}>
          <View style={styles.cookModeTitleWrap}>
            <AppText numberOfLines={1} style={styles.cookModeRecipeTitle}>
              {recipeTitle}
            </AppText>
          </View>
          <Pressable
            accessibilityLabel="Close cooking mode"
            accessibilityRole="button"
            hitSlop={10}
            onPress={handleRequestClose}
            style={({ pressed }) => [styles.closeButton, pressed && styles.pressed]}
          >
            <MaterialCommunityIcons color={appColors.muted} name="close" size={22} />
          </Pressable>
        </View>

        <View style={styles.progressBarContainer}>
          <Reanimated.View style={[styles.progressBarFill, progressBarFillStyle]} />
        </View>

        <View
          onTouchEnd={handleStepTouchEnd}
          onTouchStart={handleStepTouchStart}
          style={styles.cookModeStepArea}
        >
          <ScrollView
            ref={scrollRef}
            contentContainerStyle={styles.cookModeContent}
            showsVerticalScrollIndicator={false}
            style={styles.cookModeStepScroller}
          >
            {isFinaleVisible ? (
              renderCookModeFinale()
            ) : currentStep ? (
              <Animated.View style={[styles.cookModeStepCard, stepAnimatedStyle]}>
                <View style={styles.cookModeStepMeta}>
                  <AppText muted style={styles.cookModeStepMetaText} variant="label">
                    Step{" "}
                    <Reanimated.Text
                      key={`step-number-${currentStepIndex}`}
                      style={styles.cookModeStepMetaText}
                    >
                      {currentStepIndex + 1}
                    </Reanimated.Text>{" "}
                    of {steps.length}
                  </AppText>
                </View>
                <AppText style={styles.cookModeStepText} variant="headline">
                  {currentStep.text}
                </AppText>
                {renderStepTimerChips()}
                {renderMatchedIngredientStrip()}
                <View style={styles.cookModeIngredientReference}>
                  <Pressable
                    accessibilityLabel="Toggle ingredients visibility"
                    accessibilityRole="button"
                    onPress={toggleIngredientsExpanded}
                    style={styles.cookModeIngredientsHeader}
                  >
                    <AppText tone="accent" variant="label">
                      Ingredients
                    </AppText>
                    <Reanimated.View style={ingredientsChevronStyle}>
                      <MaterialCommunityIcons
                        color={appColors.muted}
                        name="chevron-down"
                        size={20}
                      />
                    </Reanimated.View>
                  </Pressable>
                  {isIngredientsExpanded ? <View>{renderCookModeIngredients()}</View> : null}
                </View>

                <Pressable
                  accessibilityLabel="Previous step touch zone"
                  accessibilityRole="button"
                  accessibilityState={{ disabled: isStepTransitionAnimating }}
                  disabled={isStepTransitionAnimating}
                  onPress={handlePreviousStepTap}
                  onPressIn={handleStepTapPressIn}
                  style={[styles.stepTapZone, styles.stepTapZoneLeft, { width: modalWidth / 3 }]}
                  onTouchMove={handleStepTapPressMove}
                />
                <Pressable
                  accessibilityLabel="Next step touch zone"
                  accessibilityRole="button"
                  accessibilityState={{ disabled: isStepTransitionAnimating }}
                  disabled={isStepTransitionAnimating}
                  onPress={handleNextStepTap}
                  onPressIn={handleStepTapPressIn}
                  style={[styles.stepTapZone, styles.stepTapZoneRight, { width: modalWidth / 3 }]}
                  onTouchMove={handleStepTapPressMove}
                />
              </Animated.View>
            ) : (
              <AppText style={styles.cookModeStepText} variant="headline">
                No method steps found.
              </AppText>
            )}
          </ScrollView>
        </View>

        {!isFinaleVisible ? (
          <View style={styles.cookModeFooter}>
            {areHintsVisible ? <CookModeHintCard onDismiss={dismissHints} /> : null}
            {renderActiveTimers()}
            <View style={styles.cookModeFooterRow}>
              {!isFirstStep ? (
                <Pressable
                  accessibilityLabel="Previous step"
                  accessibilityRole="button"
                  accessibilityState={{ disabled: isStepTransitionAnimating }}
                  disabled={isStepTransitionAnimating}
                  onPress={goToPreviousStep}
                  style={({ pressed }) => [
                    styles.arrowButton,
                    styles.arrowButtonSecondary,
                    pressed && styles.pressed
                  ]}
                >
                  <MaterialCommunityIcons color={appColors.accent} name="arrow-left" size={24} />
                </Pressable>
              ) : (
                <View style={styles.arrowButtonSpacer} />
              )}

              <View style={styles.keepAwakeMiddleContainer}>
                <Reanimated.View style={keepAwakeIconStyle}>
                  <MaterialCommunityIcons
                    color={keepAwake ? appColors.accent : appColors.muted}
                    name="brightness-5"
                    size={18}
                  />
                </Reanimated.View>
                <AppText style={styles.keepAwakeMiddleText}>Keep awake</AppText>
                <Switch
                  onValueChange={setKeepAwake}
                  thumbColor={keepAwake ? appColors.accent : appColors.surface}
                  trackColor={{ false: appColors.border, true: appColors.accentSoft }}
                  value={keepAwake}
                  style={styles.keepAwakeMiddleSwitch}
                />
              </View>

              <Pressable
                accessibilityLabel={isLastStep ? "Finish cooking" : "Next step"}
                accessibilityRole="button"
                accessibilityState={{ disabled: isStepTransitionAnimating }}
                disabled={isStepTransitionAnimating}
                onPress={() => goToNextStep()}
                style={({ pressed }) => [
                  styles.arrowButton,
                  styles.arrowButtonPrimary,
                  pressed && styles.pressed
                ]}
              >
                {isLastStep ? (
                  <AppText style={styles.finishButtonText}>Finish</AppText>
                ) : (
                  <MaterialCommunityIcons color={appColors.canvas} name="arrow-right" size={24} />
                )}
              </Pressable>
            </View>
          </View>
        ) : null}
      </SafeAreaView>
      <AppDialog
        actions={[
          {
            label: "Keep cooking",
            onPress: () => setIsLeaveConfirmationVisible(false),
            variant: "outline"
          },
          {
            label: "Leave",
            onPress: () => {
              setIsLeaveConfirmationVisible(false);
              setActiveTimers([]);
              closeCookMode();
            },
            variant: "danger"
          }
        ]}
        message="Running timers will stop if you leave cook mode."
        onRequestClose={() => setIsLeaveConfirmationVisible(false)}
        title="Leave cook mode?"
        visible={isLeaveConfirmationVisible}
      />
    </Modal>
  );
};

const styles = StyleSheet.create({
  activeTimerChip: {
    alignItems: "center",
    alignSelf: "flex-start",
    backgroundColor: appColors.accentSoft,
    borderColor: "rgba(41, 68, 59, 0.2)",
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: "row",
    gap: 6,
    maxWidth: "100%",
    minHeight: 30,
    paddingHorizontal: 10,
    paddingVertical: 5
  },
  activeTimerChipComplete: {
    backgroundColor: appColors.accent,
    borderColor: appColors.accent
  },
  activeTimerChipText: {
    color: appColors.accent,
    fontFamily: "serif",
    fontSize: 15,
    fontWeight: "800",
    lineHeight: 18
  },
  activeTimerChipTextComplete: {
    color: appColors.canvas
  },
  activeTimerLabel: {
    color: appColors.accent,
    flexShrink: 1,
    fontSize: 12,
    fontWeight: "700",
    lineHeight: 15
  },
  activeTimerStack: {
    alignItems: "flex-start",
    gap: 6,
    marginBottom: 10,
    width: "100%"
  },
  bullet: {
    backgroundColor: appColors.accent,
    borderRadius: 999,
    height: 6,
    marginTop: 9,
    width: 6
  },
  container: {
    gap: 44
  },
  closeButton: {
    alignItems: "center",
    borderRadius: 999,
    height: 40,
    justifyContent: "center",
    width: 40
  },
  arrowButton: {
    alignItems: "center",
    borderRadius: 14,
    height: 44,
    justifyContent: "center",
    minWidth: 44,
    paddingHorizontal: 8
  },
  arrowButtonPrimary: {
    backgroundColor: appColors.accent
  },
  arrowButtonSecondary: {
    backgroundColor: appColors.accentSoft
  },
  arrowButtonSpacer: {
    height: 44,
    width: 44
  },
  actionSlot: {
    marginTop: -24
  },
  cookModeButton: {
    alignItems: "center",
    backgroundColor: "transparent",
    borderColor: appColors.border,
    borderRadius: 12,
    borderWidth: 1,
    flexDirection: "row",
    gap: 6,
    minHeight: 34,
    paddingHorizontal: 12
  },
  cookModeButtonText: {
    color: appColors.accent,
    fontSize: 14,
    fontWeight: "700",
    lineHeight: 18
  },
  cookModeContent: {
    flexGrow: 1,
    paddingHorizontal: 24,
    paddingBottom: 24,
    paddingTop: 18
  },
  cookModeFooter: {
    backgroundColor: appColors.surface,
    borderTopColor: appColors.border,
    borderTopWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 10
  },
  cookModeFooterRow: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    width: "100%"
  },
  customScaleButton: {
    alignItems: "center",
    backgroundColor: appColors.accentSoft,
    borderRadius: 999,
    height: 30,
    justifyContent: "center",
    width: 30
  },
  customScaleRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 10,
    justifyContent: "center"
  },
  customScaleValue: {
    color: appColors.text,
    fontSize: 14,
    fontWeight: "800",
    lineHeight: 18,
    minWidth: 36,
    textAlign: "center"
  },
  cookModeFinaleBody: {
    fontSize: 16,
    lineHeight: 22,
    marginTop: 6,
    textAlign: "center"
  },
  cookModeFinaleButton: {
    alignSelf: "center",
    marginTop: 10,
    minWidth: 132
  },
  cookModeFinaleCard: {
    alignItems: "center",
    flexGrow: 1,
    gap: 14,
    justifyContent: "center",
    minHeight: 420,
    paddingHorizontal: 12,
    paddingVertical: 48,
    width: "100%"
  },
  cookModeFinaleCheck: {
    alignItems: "center",
    backgroundColor: appColors.accent,
    borderColor: appColors.accentSoft,
    borderRadius: 999,
    borderWidth: 2,
    bottom: -2,
    height: 20,
    justifyContent: "center",
    position: "absolute",
    right: -2,
    width: 20
  },
  cookModeFinaleIcon: {
    alignItems: "center",
    backgroundColor: appColors.accentSoft,
    borderRadius: 999,
    height: 56,
    justifyContent: "center",
    width: 56
  },
  cookModeFinaleTitle: {
    color: appColors.accent,
    lineHeight: 48,
    textAlign: "center"
  },
  cookModeHeader: {
    alignItems: "center",
    borderBottomColor: appColors.border,
    borderBottomWidth: 1,
    flexDirection: "row",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12
  },
  cookModeHintCard: {
    alignSelf: "stretch",
    backgroundColor: appColors.surface,
    borderColor: appColors.border,
    borderRadius: 16,
    borderWidth: 1,
    gap: 10,
    marginBottom: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    shadowColor: appColors.shadow,
    shadowOffset: { height: 8, width: 0 },
    shadowOpacity: 0.08,
    shadowRadius: 16,
    elevation: 3
  },
  cookModeHintDismiss: {
    alignSelf: "flex-start",
    minWidth: 96
  },
  cookModeHintIcon: {
    color: appColors.accent,
    fontSize: 14,
    fontWeight: "800",
    lineHeight: 19,
    minWidth: 30
  },
  cookModeHintLine: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8
  },
  cookModeHintText: {
    color: appColors.accent,
    fontSize: 14,
    fontWeight: "700",
    lineHeight: 19,
    flex: 1
  },
  cookModeRecipeTitle: {
    fontSize: 16,
    fontWeight: "700",
    lineHeight: 20,
    color: appColors.text
  },
  finishButtonText: {
    color: appColors.canvas,
    fontSize: 14,
    fontWeight: "700",
    paddingHorizontal: 6
  },
  keepAwakeMiddleContainer: {
    alignItems: "center",
    flexDirection: "row",
    gap: 6,
    justifyContent: "center"
  },
  keepAwakeMiddleText: {
    color: appColors.text,
    fontSize: 13,
    fontWeight: "600"
  },
  keepAwakeMiddleSwitch: {
    transform: [{ scaleX: 0.8 }, { scaleY: 0.8 }]
  },
  cookModeScreen: {
    backgroundColor: appColors.background,
    flex: 1
  },
  cookModeStepCard: {
    alignItems: "center",
    flexGrow: 1,
    justifyContent: "flex-start",
    paddingTop: 42,
    width: "100%"
  },
  cookModeStepArea: {
    flex: 1,
    position: "relative"
  },
  cookModeStepMeta: {
    alignItems: "center",
    gap: 12
  },
  cookModeStepMetaLine: {
    alignItems: "center"
  },
  cookModeStepMetaText: {
    color: appColors.muted,
    fontSize: 12,
    letterSpacing: 1.2,
    lineHeight: 16,
    textTransform: "uppercase"
  },
  cookModeStepScroller: {
    flex: 1
  },
  cookModeStepText: {
    fontSize: 31,
    lineHeight: 39,
    marginTop: 16,
    textAlign: "center"
  },
  cookModeIngredientGroup: {
    gap: 4
  },
  cookModeIngredientsHeader: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between"
  },
  cookModeIngredientsContent: {
    gap: 12,
    paddingTop: 12
  },
  cookModeIngredientReference: {
    alignSelf: "stretch",
    backgroundColor: appColors.surface,
    borderColor: appColors.border,
    borderRadius: 16,
    borderWidth: 1,
    marginTop: 26,
    padding: 16,
    position: "relative",
    zIndex: 3
  },
  cookModeIngredientSection: {
    color: appColors.accent,
    fontSize: 14,
    fontWeight: "800",
    letterSpacing: 0.8,
    lineHeight: 18,
    marginBottom: 2,
    textTransform: "uppercase"
  },
  cookModeIngredientCheck: {
    alignItems: "center",
    borderColor: appColors.accent,
    borderRadius: 999,
    borderWidth: 1.5,
    height: 18,
    justifyContent: "center",
    marginTop: 1,
    width: 18
  },
  cookModeIngredientCheckChecked: {
    backgroundColor: appColors.accent
  },
  cookModeIngredientRow: {
    alignItems: "flex-start",
    borderRadius: 10,
    flexDirection: "row",
    gap: 9,
    marginHorizontal: -6,
    paddingHorizontal: 6,
    paddingVertical: 4
  },
  cookModeIngredientRowPressed: {
    backgroundColor: appColors.accentSoft,
    opacity: pressedOpacity.soft
  },
  cookModeIngredientStrike: {
    backgroundColor: appColors.muted,
    height: 1,
    left: 0,
    position: "absolute",
    right: 0,
    top: 10
  },
  cookModeIngredientText: {
    color: appColors.text,
    fontSize: 15,
    lineHeight: 20
  },
  cookModeIngredientTextChecked: {
    textDecorationLine: "line-through"
  },
  cookModeIngredientTextWrap: {
    flex: 1,
    minHeight: 20
  },
  cookModeTitleWrap: {
    flex: 1,
    gap: 0
  },
  hero: {
    gap: 8
  },
  heroImage: {
    backgroundColor: appColors.accentSoft,
    borderRadius: 16,
    width: "100%"
  },
  ingredientGroup: {
    gap: 10
  },
  ingredientRow: {
    alignItems: "flex-start",
    flexDirection: "row",
    gap: 12
  },
  ingredientSection: {
    color: appColors.accent,
    fontSize: 13,
    fontWeight: "800",
    letterSpacing: 1,
    lineHeight: 18,
    textTransform: "uppercase"
  },
  list: {
    gap: 16
  },
  listText: {
    flex: 1,
    fontSize: 16,
    lineHeight: 25
  },
  scaleHeaderRow: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between"
  },
  scaleOption: {
    alignItems: "center",
    borderColor: appColors.border,
    borderRadius: 10,
    borderWidth: 1,
    flex: 1,
    justifyContent: "center",
    minHeight: 34,
    paddingHorizontal: 8
  },
  scaleOptionRow: {
    flexDirection: "row",
    gap: 6
  },
  scaleOptionSelected: {
    backgroundColor: appColors.accent,
    borderColor: appColors.accent
  },
  scaleOptionText: {
    color: appColors.accent,
    fontSize: 12,
    fontWeight: "800",
    lineHeight: 16,
    textAlign: "center"
  },
  scaleOptionTextSelected: {
    color: appColors.canvas
  },
  scalePanel: {
    backgroundColor: appColors.surface,
    borderColor: appColors.border,
    borderRadius: 12,
    borderWidth: 1,
    gap: 10,
    padding: 12
  },
  scalingHonestyNote: {
    fontSize: 12,
    lineHeight: 17
  },
  methodSection: {
    color: appColors.accent,
    fontSize: 12,
    fontWeight: "800",
    letterSpacing: 0.8,
    lineHeight: 16,
    textTransform: "uppercase"
  },
  methodStepGroup: {
    gap: 6
  },
  recipeMetaLine: {
    fontSize: 13,
    lineHeight: 18
  },
  metaGrid: {
    gap: 0
  },
  metaLabel: {
    flex: 1,
    fontSize: 13,
    lineHeight: 18
  },
  metaRow: {
    alignItems: "center",
    borderBottomColor: "rgba(221, 210, 195, 0.6)",
    borderBottomWidth: 1,
    flexDirection: "row",
    gap: 14,
    justifyContent: "space-between",
    paddingVertical: 11
  },
  metaValue: {
    color: appColors.text,
    flex: 1,
    fontSize: 16,
    fontWeight: "700",
    lineHeight: 22,
    textAlign: "right"
  },
  previewLabel: {
    marginBottom: 2
  },
  progressBarContainer: {
    backgroundColor: appColors.border,
    height: 4,
    width: "100%"
  },
  progressBarFill: {
    backgroundColor: appColors.accent,
    height: "100%"
  },
  pressed: {
    opacity: pressedOpacity.firm
  },
  recipeTitle: {
    fontSize: 34,
    letterSpacing: 0,
    lineHeight: 39
  },
  section: {
    gap: 18
  },
  sectionHeading: {
    alignItems: "center",
    flexDirection: "row",
    gap: 12,
    justifyContent: "space-between"
  },
  sectionLabelLine: {
    alignItems: "center",
    flex: 1,
    flexDirection: "row",
    gap: 12
  },
  sectionRule: {
    backgroundColor: "rgba(41, 68, 59, 0.32)",
    flex: 1,
    height: StyleSheet.hairlineWidth
  },
  stepIngredientLine: {
    fontSize: 13,
    lineHeight: 18
  },
  stepIngredientStrip: {
    alignSelf: "stretch",
    borderTopColor: appColors.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: 4,
    marginTop: 18,
    paddingTop: 12
  },
  stepIndex: {
    alignItems: "center",
    backgroundColor: appColors.accentSoft,
    borderRadius: 999,
    height: 28,
    justifyContent: "center",
    width: 28
  },
  stepIndexText: {
    color: appColors.accent,
    fontSize: 15,
    lineHeight: 18
  },
  stepRow: {
    alignItems: "flex-start",
    flexDirection: "row",
    gap: 12
  },
  stepTapZone: {
    bottom: 0,
    position: "absolute",
    top: 0,
    zIndex: 2
  },
  stepTapZoneLeft: {
    left: 0
  },
  stepTapZoneRight: {
    right: 0
  },
  stepTimerChip: {
    alignItems: "center",
    alignSelf: "center",
    backgroundColor: appColors.accentSoft,
    borderColor: "rgba(41, 68, 59, 0.22)",
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: "row",
    gap: 5,
    minHeight: 32,
    paddingHorizontal: 11,
    paddingVertical: 6
  },
  stepTimerChipRow: {
    alignItems: "center",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    justifyContent: "center",
    marginTop: 18,
    position: "relative",
    zIndex: 3
  },
  stepTimerChipText: {
    color: appColors.accent,
    fontFamily: "serif",
    fontSize: 14,
    fontWeight: "800",
    lineHeight: 17
  },
  unitToggleOption: {
    alignItems: "center",
    borderRadius: 999,
    flex: 1,
    minHeight: 30,
    justifyContent: "center",
    paddingHorizontal: 10
  },
  unitToggleOptionSelected: {
    backgroundColor: appColors.accentSoft
  },
  unitToggleRow: {
    backgroundColor: appColors.background,
    borderRadius: 999,
    flexDirection: "row",
    padding: 3
  },
  unitToggleText: {
    color: appColors.muted,
    fontSize: 12,
    fontWeight: "800",
    lineHeight: 16
  },
  unitToggleTextSelected: {
    color: appColors.accent
  }
});
