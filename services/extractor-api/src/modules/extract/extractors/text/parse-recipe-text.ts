/*
 * A rule-based reader for recipe text that did not come with structured data: pasted notes, a
 * TikTok caption, a YouTube description. It only reports what the text itself says. Ingredients
 * and steps are told apart by their headings ("Ingredients", "Method"...) or, without headings,
 * by line shape (quantities first, then sentences). When neither works it reports no structure
 * rather than guessing, and the caller turns that into a plain "no recipe found".
 */

export interface ParsedRecipeIngredient {
  text: string;
  section: string | null;
}

export interface ParsedRecipeText {
  /** A title line the text itself opens with, if any. */
  title: string | null;
  ingredients: ParsedRecipeIngredient[];
  steps: string[];
  servings: string | null;
  prepTimeMinutes: number | null;
  cookTimeMinutes: number | null;
  totalTimeMinutes: number | null;
  /**
   * "headings": the text labels its ingredients (and usually its method); "layout": no headings,
   * but a run of quantity lines followed by method sentences; null: no recipe structure found.
   */
  structure: "headings" | "layout" | null;
  /**
   * Where the steps came from: a method heading, method lines after an unlabelled list, or only
   * short notes between the ingredient groups ("*Chill for 30 minutes"); null when there are none.
   */
  methodSource: "heading" | "layout" | "notes" | null;
}

const fractionCharacters = "½⅓⅔¼¾⅛⅜⅝⅞";
const numberWords =
  "a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|half|a few|a couple of";
const unitWords =
  "cups?|c\\.|tbsps?|tablespoons?|tbs|tbl|tsps?|teaspoons?|g|gr|grams?|kg|kilos?|kilograms?|mg|ml|millilit(?:er|re)s?|cl|dl|l|lit(?:er|re)s?|oz|ounces?|fl\\.? ?oz|lbs?|pounds?|cloves?|pinch(?:es)?|dash(?:es)?|cans?|tins?|jars?|sticks?|slices?|pieces?|packets?|packages?|pkgs?|bunch(?:es)?|handfuls?|sprigs?|stalks?|heads?|knobs?|sheets?|quarts?|qts?|pints?|pts?|gallons?|inch(?:es)?|cm|large|medium|small|whole|el|tl|cs|cc";

/* "2", "1/2", "1 1/2", "1.5", "2-3", "½", "1½" at the start of a line. */
const leadingQuantityPattern = new RegExp(
  `^(?:\\d+\\s+\\d+\\/\\d+|\\d+(?:[.,/]\\d+)?[${fractionCharacters}]?|[${fractionCharacters}])(?:\\s*(?:-|–|to)\\s*\\d+(?:[.,/]\\d+)?)?(?=\\s|[a-z${fractionCharacters}]|$)`,
  "iu"
);
const leadingNumberWordPattern = new RegExp(
  `^(?:${numberWords})\\s+(?:${unitWords}|pinch|dash|splash|handful|knob|few|couple|bunch|sprig)\\b`,
  "iu"
);
const quantityWithUnitPattern = new RegExp(
  `(?:\\d+(?:[.,/]\\d+)?|[${fractionCharacters}])\\s*(?:${unitWords})\\b`,
  "iu"
);
const abbreviationEndPattern = new RegExp(`\\b(?:${unitWords}|approx|e\\.g|i\\.e)$`, "iu");

/*
 * Where sentences end: the index of each ".", "!" or "?" followed by a capital, skipping
 * abbreviations ("1 tsp. Salt", "approx. 2 cups").
 */
const findSentenceBreaks = (value: string): number[] =>
  [...value.matchAll(/[.!?]\s+(?=\p{Lu})/gu)]
    .map((match) => match.index)
    .filter((index) => value[index] !== "." || !abbreviationEndPattern.test(value.slice(0, index)));

const hasSentenceBreak = (line: string): boolean => findSentenceBreaks(line).length > 0;

const toTastePattern =
  /\b(?:to taste|as needed|for (?:garnish|serving|frying|greasing|dusting)|optional)\b/iu;

const cookingVerbs =
  "add|arrange|assemble|bake|baste|beat|blanch|blend|boil|braise|bring|broil|brown|brush|caramelize|chill|chop|coat|combine|cook|cool|cover|cream|crush|cut|decorate|deglaze|dice|dip|discard|dissolve|divide|drain|drizzle|dust|empty|fill|flip|fold|form|freeze|freezing|fry|garnish|grate|grease|grill|heat|incorporate|insert|knead|layer|leave|let|line|marinate|mash|measure|melt|microwave|mince|mix|place|poach|pour|preheat|prepare|press|puree|purée|put|reduce|refrigerate|remove|repeat|rest|return|rinse|roast|roll|rub|saute|sauté|scatter|scoop|sear|season|separate|serve|set|shape|shred|sift|simmer|skim|slice|soak|spoon|spread|sprinkle|squeeze|steam|stir|strain|stuff|swirl|take|taste|thicken|toast|top|toss|transfer|trim|turn|wash|whip|whisk|wrap";
const leadingVerbPattern = new RegExp(
  `^(?:then |now |next |finally |first |and )?(?:${cookingVerbs})\\b`,
  "iu"
);

const ingredientHeadingPattern =
  /^(?:the\s+)?(?:ingredients? list|ingredients?|what you(?:'|’)?ll need|what you need|you(?:'|’)?ll need|you will need|shopping list|zutaten|ingrédients|ingredientes|ingredienti|ingrediënten)\b/iu;
const stepHeadingPattern =
  /^(?:instructions?|directions?|method|steps?|preparation|how to make(?: it| them)?|how to cook(?: it)?|how to prepare|procedure|cooking instructions|recipe steps|zubereitung|préparation|preparación|preparazione|bereiding)\b/iu;
const stopHeadingPattern =
  /^(?:notes?|tips?(?: and tricks| & tricks)?|recipe notes|cook'?s notes|chef'?s notes|nutrition(?: facts| information| info)?|equipment|tools|storage|how to store|to store|serving suggestions?|substitutions?|variations?|faqs?|more recipes|related recipes|chapters|timestamps|music|credits|disclaimer|affiliate links?)\b/iu;

/* Lines that are channel or caption chrome, never recipe content. */
const promotionalLinePattern =
  /^(?:follow (?:me|us|my|our|along|on|@)|subscribe|like and subscribe|please subscribe|check out|shop|use (?:my )?code|link in (?:my )?bio|business (?:inquiries|enquiries)|instagram|tiktok|facebook|twitter|pinterest|website|blog|email|contact|my (?:camera|gear|kitchen tools)|support (?:me|the channel)|join (?:me|us|my|our|the (?:channel|community|club|newsletter))|patreon|merch|©|all rights reserved|thanks for watching|thank you for watching)\b/iu;
/*
 * A video description's sign-off ("Thanks for watching", "Like and share this video", "Turn on
 * the bell", subtitle hints, a list of other videos). Everything after it is channel chrome.
 */
const outroLinePattern =
  /^(?:thanks? (?:you )?for (?:watching|your support|the support)|please (?:like|share|subscribe)|like (?:and|&) (?:share|subscribe)|subscribe\b|(?:turn on|hit|click|press) (?:the )?(?:post |little |notification )*(?:bell|notifications?)|(?:friends,? )?if you (?:like|enjoyed) (?:the|this|my) video|share (?:the|this) video|activate (?:the )?subtitles|you can (?:enable|turn on) (?:the )?(?:language )?subtitles|(?:best|more|other|popular) recipes|watch (?:more|next)|related videos?|playlists?)\b/iu;
/* Recipe section names that stand alone without a colon ("Decoration", "Sauce"). */
const sectionWordPattern =
  /^(?:for (?:the )?)?(?:[\p{L}]+ )?(?:decorations?|toppings?|sauce|dressing|filling|frosting|icing|glaze|marinade|batter|dough|crust|base|garnish|syrup|ganache|custard|streusel|crumble|coating|seasoning|assembly)$/iu;
const urlPattern = /https?:\/\/[^\s<>"')\]]+/giu;
const hashtagOnlyPattern = /^(?:[#@][\p{L}\p{N}_.]+[\s,]*)+$/u;
const trailingHashtagsPattern = /(?:\s+[#@][\p{L}\p{N}_.]+)+\s*$/u;

const servingsLinePattern =
  /^(?:serves|servings?|serving size|yields?|makes|portions?|for)\s*[:\-–]?\s*(\d[^\n]{0,40}|[a-z]+ (?:people|servings?|portions?))$/iu;
/* "Prep time 15 min", "Cook: 1 hour", "Ready in 30 minutes"; never "Cook pasta for 10 minutes". */
const timeLinePattern =
  /^(prep(?:aration)?|cook(?:ing)?|bak(?:e|ing)|total|active|ready in)(\s*time)?\s*([:\-–])?\s*((?:about |approx\.? |around )?\d.{0,28})$/iu;

/* "1. 2 eggs": a numbered ingredient list, whose items start with their own amounts. */
const listNumberPattern = /^\d{1,2}[.)]\s+(?=[\d½⅓⅔¼¾⅛⅜⅝⅞])/u;
/* "10 min", "1 hour 30 minutes", "about 1.5 hours", "1 day": a duration and nothing else. */
const bareDurationPattern =
  /^(?:about |approx\.? |around )?\d+(?:[.,]\d+)?\s*(?:d|days?|h|hrs?|hours?|m|mins?|minutes?)(?:\s+\d+\s*(?:h|hrs?|hours?|m|mins?|minutes?))*\.?$/iu;

/* "1. Mix", "2) Bake", "Step 3: Serve"; not "1.5 cups" or "2-3 cloves". */
const stepMarkerPattern = /^(?:step\s*)?(\d{1,2})\s*[.):\-–]\s*(?=[^\d\s.,/½⅓⅔¼¾⅛⅜⅝⅞])/iu;
const stepWordMarkerPattern = /^step\s*\d{1,2}\b\s*[:.\-–]?\s*/iu;

const descriptorStarts =
  /^(?:chopped|diced|minced|sliced|grated|shredded|sifted|divided|softened|melted|beaten|peeled|crushed|cubed|drained|rinsed|halved|quartered|at room temperature|room temperature|to taste|optional|plus more|or more|or to taste|finely|roughly|thinly|freshly|lightly|packed|heaped|level|cut into|about|approximately|such as|e\.g\.|ie|i\.e\.)\b/iu;

const maxIngredientLength = 160;
const maxTitleLength = 100;

const stripDecorations = (line: string): string =>
  line
    .replace(/\*\*|__/gu, "")
    .replace(/^#{1,6}\s+/u, "")
    .replace(
      /^(?:[\s\p{Extended_Pictographic}•·▪◦●○►▶▸➤➔→✔✓✗☐☑▢□■◆◇★☆*>|~-]|\u{FE0F}|\u{200D}|\u{20E3})+/u,
      ""
    )
    .replace(/^[-–—]\s+/u, "")
    .replace(/^\[\s?[xX]?\s?\]\s*/u, "")
    .replace(trailingHashtagsPattern, "")
    .replace(/(?:[\s\p{Extended_Pictographic}]|\u{FE0F}|\u{200D})+$/u, "")
    .replace(/\s+/gu, " ")
    .trim();

/*
 * Captions and descriptions often run a whole recipe into one line. Before line-based parsing,
 * section labels, bullets, emoji bullets and inline step numbers each start a new line, at any
 * line length. Only " - " waits for a long line: a short "Cook - 2 minutes" is one line.
 */
const splitRunOnLine = (line: string): string[] => {
  let split = line
    .replace(
      /\s+(?=(?:ingredients? list|ingredients?|zutaten|ingrédients|ingredientes|ingredienti|ingrediënten|instructions?|cooking instructions|directions?|method|steps?|recipe steps|preparation|procedure|how to (?:make|cook|prepare)(?: it| them)?|zubereitung|préparation|preparación|preparazione|bereiding)\s*:)/giu,
      "\n"
    )
    .replace(/\s+[•·▪◦●►▶▸➤✔✓✅☑]\s*/gu, "\n")
    .replace(/\s+(?=\p{Extended_Pictographic}\u{FE0F}?\s*(?:\d|[½⅓⅔¼¾⅛⅜⅝⅞]))/gu, "\n");

  if (line.length >= 100) {
    split = split.replace(/(?<!\d)\s+-\s+(?=\d|[½⅓⅔¼¾⅛⅜⅝⅞])/gu, "\n");
  }

  const inlineStepMarkers = split.match(/(?:^|\s)(?:step\s*)?\d{1,2}[.)]\s+(?=\p{Lu}|\p{Ll})/giu);

  if (inlineStepMarkers && inlineStepMarkers.length >= 2) {
    split = split.replace(/\s+(?=(?:step\s*)?\d{1,2}[.)]\s+(?:\p{Lu}|\p{Ll}))/giu, "\n");
  }

  return split.split("\n");
};

/* A cleaned line, and whether it was written as a "*note" (a method note inside a list). */
interface TextLine {
  text: string;
  note: boolean;
}

const toLines = (text: string): string[] =>
  text
    .replace(/\r\n?/gu, "\n")
    .replace(/[\u200B\u200C\u2060\uFEFF]/gu, "")
    .replace(/\u00A0/gu, " ")
    .replace(/\\n/gu, "\n")
    /* Keycap emoji numbers ("1\uFE0F\u20E3 Mix") read as "1. Mix". */
    .replace(/(\d)\uFE0F?\u20E3\s*/gu, "$1. ")
    .split("\n")
    .flatMap(splitRunOnLine)
    .map((line) => line.replace(urlPattern, "").replace(/\s+/gu, " ").trim());

const withoutPictographs = (line: string): string =>
  line
    .replace(/\p{Extended_Pictographic}|\u{FE0F}|\u{200D}/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();

const isOutroLine = (cleaned: string): boolean =>
  outroLinePattern.test(withoutPictographs(cleaned));

const isNoiseLine = (rawLine: string, cleaned: string): boolean =>
  cleaned.length === 0 ||
  hashtagOnlyPattern.test(rawLine.trim()) ||
  promotionalLinePattern.test(cleaned) ||
  /^\d{1,2}:\d{2}(?::\d{2})?\b/u.test(cleaned) ||
  !/[\p{L}\p{N}]/u.test(cleaned);

type Heading =
  | { kind: "ingredients"; inline: string }
  | { kind: "steps"; inline: string }
  | { kind: "stop" };

/*
 * A heading is the label alone ("Ingredients", "Method:"), the label with a short qualifier
 * ("Ingredients (serves 4)", "Ingredients for the dough"), or the label followed by a colon and
 * the section's content on the same line ("Ingredients: 2 eggs, 1 cup flour").
 */
const readHeading = (line: string): Heading | null => {
  const ingredientMatch = line.match(ingredientHeadingPattern);
  const stepMatch = ingredientMatch ? null : line.match(stepHeadingPattern);
  const match = ingredientMatch ?? stepMatch;

  if (match) {
    const rest = line.slice(match[0].length).trim();
    const kind = ingredientMatch ? "ingredients" : "steps";

    /* "Step 1: mix" is a step, and "Preparation time: 15 minutes" a time, not the method heading. */
    if (/^\d/u.test(rest) || (kind === "steps" && /^time\b/iu.test(rest))) {
      return null;
    }

    if (rest.length === 0 || /^[:\-–—]+$/u.test(rest)) {
      return { kind, inline: "" };
    }

    if (/^[:\-–—]/u.test(rest)) {
      const inline = rest.replace(/^[:\-–—]+\s*/u, "");

      /* "Preparation: 15 minutes" is a time, not the method. */
      if (kind === "steps" && /^\d+\s*(?:min|minutes?|hours?|hrs?|h)\b/iu.test(inline)) {
        return null;
      }

      return { kind, inline };
    }

    if (rest.length <= 40 && !leadingVerbPattern.test(rest) && !/[.!?]$/u.test(rest)) {
      return { kind, inline: "" };
    }

    return null;
  }

  const stopMatch = line.match(stopHeadingPattern);

  if (stopMatch) {
    const rest = line.slice(stopMatch[0].length).trim();

    /* "Notes for the cake" is a heading; "Note the dough is sticky." is a step. */
    if (
      rest.length === 0 ||
      /^[:\-–—]/u.test(rest) ||
      (rest.length <= 30 &&
        !/[.!?]$/u.test(rest) &&
        !/^(?:that|the|this|these|it|how|you|if|when)\b/iu.test(rest) &&
        !leadingVerbPattern.test(rest))
    ) {
      return { kind: "stop" };
    }
  }

  return null;
};

/* "For the sauce:", "Frosting:", "Dough" (with a colon) inside an ingredient list. */
const readSubsectionHeading = (line: string): string | null => {
  /* "Tasty Recipe:" labels the whole recipe, not a group of it. */
  if (/\brecipes?\s*:?$/iu.test(line)) {
    return null;
  }

  const forMatch = line.match(/^for (?:the )?(.{2,40}?)\s*:?$/iu);

  if (forMatch?.[1] && !startsWithQuantity(forMatch[1])) {
    return capitalize(forMatch[1]);
  }

  const colonMatch = line.match(/^(.{2,40}?)\s*:$/u);

  if (
    colonMatch?.[1] &&
    !startsWithQuantity(colonMatch[1]) &&
    !quantityWithUnitPattern.test(colonMatch[1]) &&
    colonMatch[1].split(/\s+/u).length <= 6
  ) {
    return capitalize(colonMatch[1]);
  }

  return null;
};

/* "Salt", "Chocolate sprinkles": an ingredient without an amount, in a list. */
const looksLikeUnmeasuredItem = (line: string): boolean =>
  line.split(/\s+/u).length <= 5 && !looksLikeStepLine(line) && !/[.!?:]$/u.test(line);

/* "Decoration", "Sauce": a section name on its own line, directly above its ingredients. */
const readSectionWordHeading = (line: string, next: string | undefined): string | null =>
  sectionWordPattern.test(line) &&
  next !== undefined &&
  (looksLikeIngredientLine(next) || looksLikeUnmeasuredItem(next))
    ? capitalize(line)
    : null;

const capitalize = (value: string): string =>
  value.length === 0 ? value : value[0]!.toUpperCase() + value.slice(1);

const startsWithQuantity = (line: string): boolean =>
  leadingQuantityPattern.test(line) || leadingNumberWordPattern.test(line);

/* A line that reads like one ingredient: a short line with an amount, or a "to taste" item. */
const looksLikeIngredientLine = (rawLine: string): boolean => {
  if (stepMarkerPattern.test(rawLine)) {
    return false;
  }

  const line = rawLine.replace(listNumberPattern, "");

  if (line.length > maxIngredientLength) {
    return false;
  }

  if (leadingVerbPattern.test(line) && !startsWithQuantity(line)) {
    return false;
  }

  /* Two or more sentences is method text, whatever amounts it mentions. */
  if (hasSentenceBreak(line)) {
    return false;
  }

  return (
    startsWithQuantity(line) ||
    (quantityWithUnitPattern.test(line) && line.length <= 80) ||
    (toTastePattern.test(line) && line.length <= 60)
  );
};

const looksLikeStepLine = (line: string): boolean =>
  stepMarkerPattern.test(line) ||
  stepWordMarkerPattern.test(line) ||
  leadingVerbPattern.test(line) ||
  (line.length >= 50 && /[.!?]$/u.test(line));

/*
 * Whether more ingredients follow within the next few lines (past section names and notes), so a
 * method-like line here is a note between ingredient groups, not the start of the method.
 */
const ingredientsFollow = (lines: readonly TextLine[], index: number): boolean => {
  for (let next = index + 1; next < Math.min(lines.length, index + 4); next += 1) {
    const line = lines[next]!.text;

    if (looksLikeIngredientLine(line) || readHeading(line)?.kind === "ingredients") {
      return true;
    }

    const isSectionName =
      readSubsectionHeading(line) !== null ||
      readSectionWordHeading(line, lines[next + 1]?.text) !== null;

    if (!isSectionName && !lines[next]!.note) {
      return false;
    }
  }

  return false;
};

const isListNote = (lines: readonly TextLine[], index: number): boolean => {
  const line = lines[index]!;

  return (
    !looksLikeIngredientLine(line.text) &&
    (line.note || looksLikeStepLine(line.text)) &&
    ingredientsFollow(lines, index)
  );
};

const stripListNumber = (line: string): string =>
  line.replace(stepMarkerPattern, "").replace(listNumberPattern, "");

const stripStepMarker = (line: string): string =>
  line.replace(stepWordMarkerPattern, "").replace(stepMarkerPattern, "").trim();

/* "200g pasta, 3 cloves garlic, 2 tbsp butter": a list run into one line. */
const splitInlineIngredients = (value: string): string[] => {
  const parts = value
    /* Not the decimal comma in "1,5 kg". */
    .split(/\s*;\s*|\s*(?<!\d),\s*|\s*,(?!\d)\s*|\s+(?:and|&)\s+(?=\d|[½⅓⅔¼¾⅛⅜⅝⅞])/u)
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length < 2) {
    return [value.trim()].filter(Boolean);
  }

  const merged: string[] = [];

  for (const part of parts) {
    const previous = merged.at(-1);

    /* "1 cup flour, sifted" keeps its descriptor; "salt, pepper" stay two ingredients. */
    if (previous && (descriptorStarts.test(part) || /^[a-z]+ed\b/u.test(part))) {
      merged[merged.length - 1] = `${previous}, ${part}`;
      continue;
    }

    merged.push(part);
  }

  return merged;
};

/* An ingredient line splits only when it is clearly several amounts run together. */
const splitIngredientLine = (line: string): string[] => {
  if (!/[,;]/u.test(line)) {
    return [line];
  }

  const parts = splitInlineIngredients(line);
  const quantityParts = parts.filter(startsWithQuantity).length;

  return quantityParts >= 2 ? parts : [line];
};

const splitSentences = (value: string): string[] => {
  const sentences: string[] = [];
  let start = 0;

  for (const index of findSentenceBreaks(value)) {
    sentences.push(value.slice(start, index + 1));
    start = index + 1;
  }

  sentences.push(value.slice(start));
  return sentences.map((sentence) => sentence.trim()).filter(Boolean);
};

const cleanTitle = (line: string): string | null => {
  const title = line
    .replace(/^(?:recipe|title)\s*[:\-–]\s*/iu, "")
    .replace(/(?:[\s\p{Extended_Pictographic}❗!]|\u{FE0F}|\u{200D})+$/u, "")
    .replace(/\s*[|\-–—]\s*(?:recipe|easy recipe)$/iu, "")
    .trim();

  return title.length >= 2 && title.length <= maxTitleLength ? title : null;
};

const looksLikeTitleLine = (line: string): boolean =>
  line.length <= maxTitleLength &&
  !startsWithQuantity(line) &&
  !stepMarkerPattern.test(line) &&
  !/[.?]$/u.test(line) &&
  /* "Title: Pancakes" and "Recipe: Pancakes" are titles; other "Label: text" lines are not. */
  (!/:\s*\S/u.test(line) || /^(?:title|recipe)\s*:\s*\S/iu.test(line)) &&
  readHeading(line) === null;

/* "1 day 2 hours", "1 hour 30 min", "1.5 hours", "1,5 h", "45 mins" in minutes; null without a unit. */
const parseDurationMinutes = (value: string): number | null => {
  const days = value.match(/(\d+(?:[.,]\d+)?)\s*d(?:ays?)?\b/iu);
  const hours = value.match(/(\d+(?:[.,]\d+)?)\s*h(?:ours?|rs?)?\b/iu);
  const minutes = value.match(/(\d+)\s*m(?:in(?:ute)?s?)?\b/iu);

  if (!days && !hours && !minutes) {
    return null;
  }

  const count = (match: RegExpMatchArray | null) =>
    match?.[1] ? Number(match[1].replace(",", ".")) : 0;

  return Math.round(count(days) * 24 * 60 + count(hours) * 60) + count(minutes);
};

interface Metadata {
  servings: string | null;
  prepTimeMinutes: number | null;
  cookTimeMinutes: number | null;
  totalTimeMinutes: number | null;
}

/* "Serves 4", "Prep time: 15 mins", "Prep: 10 min | Cook: 20 min". Returns false for other lines. */
const readMetadataLine = (line: string, metadata: Metadata): boolean => {
  const parts = line
    /* A comma separates "Serves 4, Prep 10 min" but not "Prep time: 1 hour, 30 minutes". */
    .split(
      /\s*[|•·]\s*|\s*,\s*(?=(?:serves|servings?|yields?|makes|portions?|prep|cook|bak(?:e|ing)|total|active|ready in)\b)/iu
    )
    .map((part) => part.trim())
    .filter(Boolean);
  let matchedAll = parts.length > 0;
  const updates: Partial<Metadata> = {};

  for (const part of parts) {
    const servingsMatch = part.match(servingsLinePattern);

    if (servingsMatch?.[1]) {
      updates.servings ??= servingsMatch[1].replace(/[.)]+$/u, "").trim();
      continue;
    }

    const timeMatch = part.match(timeLinePattern);
    /*
     * "Prep 10 min" and "Total 1 hour" need no "time" or colon; "Cook 20 minutes" alone could be a
     * step, so the verbs count only beside other metadata ("Prep 10 min | Cook 20 min").
     */
    const bareLabel = timeMatch?.[1]?.toLowerCase() ?? "";
    const labelled = Boolean(
      timeMatch?.[2] ||
      timeMatch?.[3] ||
      bareLabel === "ready in" ||
      (timeMatch?.[4] &&
        bareDurationPattern.test(timeMatch[4]) &&
        (parts.length > 1 || !/^(?:cook|bake)$/u.test(bareLabel)))
    );
    const minutes = timeMatch?.[4] && labelled ? parseDurationMinutes(timeMatch[4]) : null;

    if (timeMatch?.[1] && minutes != null) {
      const label = timeMatch[1].toLowerCase();

      if (label.startsWith("prep") || label === "active") {
        updates.prepTimeMinutes ??= minutes;
      } else if (label.startsWith("cook") || label.startsWith("bak")) {
        updates.cookTimeMinutes ??= minutes;
      } else {
        updates.totalTimeMinutes ??= minutes;
      }

      continue;
    }

    matchedAll = false;
  }

  if (!matchedAll) {
    return false;
  }

  metadata.servings ??= updates.servings ?? null;
  metadata.prepTimeMinutes ??= updates.prepTimeMinutes ?? null;
  metadata.cookTimeMinutes ??= updates.cookTimeMinutes ?? null;
  metadata.totalTimeMinutes ??= updates.totalTimeMinutes ?? null;
  return true;
};

interface StepBuilder {
  steps: string[];
  numbered: boolean;
  pendingPrefix: string | null;
}

const addStepLine = (builder: StepBuilder, line: string): void => {
  const numbered = stepMarkerPattern.test(line) || stepWordMarkerPattern.test(line);
  const text = stripStepMarker(line);

  if (text.length === 0) {
    return;
  }

  /* A wrapped line under a numbered step belongs to that step. */
  if (!numbered && builder.numbered && builder.steps.length > 0 && !/^\p{Lu}/u.test(text)) {
    builder.steps[builder.steps.length - 1] = `${builder.steps.at(-1)} ${text}`;
    return;
  }

  builder.numbered ||= numbered;
  const pieces = !numbered && text.length > 280 ? splitSentences(text) : [text];
  const [first, ...rest] = pieces;

  if (!first) {
    return;
  }

  builder.steps.push(builder.pendingPrefix ? `${builder.pendingPrefix}: ${first}` : first);
  builder.pendingPrefix = null;
  builder.steps.push(...rest);
};

const parseWithHeadings = (lines: TextLine[], metadata: Metadata): ParsedRecipeText | null => {
  let state: "preamble" | "ingredients" | "steps" | "stopped" = "preamble";
  let sawIngredientHeading = false;
  let sawStepHeading = false;
  let section: string | null = null;
  const preamble: string[] = [];
  const ingredients: ParsedRecipeIngredient[] = [];
  const notes: string[] = [];
  const stepBuilder: StepBuilder = { steps: [], numbered: false, pendingPrefix: null };

  const addIngredients = (line: string) => {
    for (const text of splitIngredientLine(stripListNumber(line))) {
      if (text.length > 0 && text.length <= maxIngredientLength) {
        ingredients.push({ text, section });
      }
    }
  };

  for (const [index, { text: line }] of lines.entries()) {
    const heading = readHeading(line);

    if (heading?.kind === "ingredients") {
      sawIngredientHeading = true;
      state = "ingredients";
      section = null;

      /* "Ingredients: 1 lb beef, 1 can beans. Brown the beef..." runs on into the method. */
      const methodStart = findSentenceBreaks(heading.inline)[0] ?? -1;
      const inlineIngredients =
        methodStart >= 0 ? heading.inline.slice(0, methodStart) : heading.inline;

      for (const item of splitInlineIngredients(inlineIngredients)) {
        addIngredients(item);
      }

      if (methodStart >= 0) {
        state = "steps";

        for (const step of splitSentences(heading.inline.slice(methodStart + 1).trim())) {
          addStepLine(stepBuilder, step);
        }
      }

      continue;
    }

    if (heading?.kind === "steps") {
      sawStepHeading = true;
      state = "steps";

      if (heading.inline) {
        const inlineSteps = splitSentences(heading.inline);
        for (const step of inlineSteps) {
          addStepLine(stepBuilder, step);
        }
      }

      continue;
    }

    if (heading?.kind === "stop") {
      if (state !== "preamble") {
        state = "stopped";
      }

      continue;
    }

    if (state === "stopped") {
      continue;
    }

    if (readMetadataLine(line, metadata)) {
      continue;
    }

    if (state === "preamble") {
      preamble.push(line);
      continue;
    }

    if (state === "ingredients") {
      const subsection =
        readSubsectionHeading(line) ?? readSectionWordHeading(line, lines[index + 1]?.text);

      if (subsection) {
        section = subsection;
        continue;
      }

      /* "*Chill for 30 minutes" between two ingredient groups. */
      if (isListNote(lines, index)) {
        notes.push(stripStepMarker(line));
        continue;
      }

      /* An unlabelled method straight after the list ends the ingredients. */
      if (
        ingredients.length > 0 &&
        !looksLikeIngredientLine(line) &&
        (stepMarkerPattern.test(line) ||
          (looksLikeStepLine(line) && (line.length >= 25 || !ingredientsFollow(lines, index))))
      ) {
        state = "steps";
        addStepLine(stepBuilder, line);
        continue;
      }

      /* "Full recipe:" and other labels are not ingredients. */
      if (
        line.length <= maxIngredientLength &&
        !hasSentenceBreak(line) &&
        !(/:$/u.test(line) && !looksLikeIngredientLine(line))
      ) {
        addIngredients(line);
      }

      continue;
    }

    const stepSubsection = readSubsectionHeading(line);

    if (stepSubsection && !looksLikeStepLine(line)) {
      stepBuilder.pendingPrefix = stepSubsection;
      continue;
    }

    addStepLine(stepBuilder, line);
  }

  if (!sawIngredientHeading && !sawStepHeading) {
    return null;
  }

  let titleSource = preamble;

  /* A method heading without an ingredient heading: the ingredient lines sit above it. */
  if (!sawIngredientHeading) {
    const firstIngredient = preamble.findIndex(looksLikeIngredientLine);

    if (firstIngredient >= 0) {
      titleSource = preamble.slice(0, firstIngredient);

      for (const line of preamble.slice(firstIngredient)) {
        const subsection = readSubsectionHeading(line);

        if (subsection) {
          section = subsection;
        } else if (looksLikeIngredientLine(line) || line.split(/\s+/u).length <= 4) {
          addIngredients(line);
        }
      }
    }
  }

  const titleLine = titleSource.find(looksLikeTitleLine);
  const steps = [...notes, ...stepBuilder.steps];

  return {
    title: titleLine ? cleanTitle(titleLine) : null,
    ingredients,
    steps,
    ...metadata,
    structure: ingredients.length > 0 ? "headings" : null,
    methodSource:
      stepBuilder.steps.length > 0
        ? sawStepHeading
          ? "heading"
          : "layout"
        : notes.length > 0
          ? "notes"
          : null
  };
};

/*
 * No headings: the recipe is read from line shape. It needs a run of at least three ingredient
 * lines (short lines with amounts, allowing short unmeasured ones such as "Salt", section names
 * and notes between them) followed by method lines.
 */
const parseByLayout = (lines: TextLine[], metadata: Metadata): ParsedRecipeText | null => {
  const contentLines = lines.filter((line) => !readMetadataLine(line.text, metadata));
  const start = contentLines.findIndex((line) => looksLikeIngredientLine(line.text));

  if (start < 0) {
    return null;
  }

  const ingredients: ParsedRecipeIngredient[] = [];
  const notes: string[] = [];
  /* "Flour:" right above the first amount names the first group. */
  let section: string | null =
    start > 0 ? readSubsectionHeading(contentLines[start - 1]!.text) : null;
  /* Whether the line before was an ingredient or a section name, so the list goes on. */
  let inList = false;
  let index = start;

  for (; index < contentLines.length; index += 1) {
    const line = contentLines[index]!.text;
    const next = contentLines[index + 1]?.text;

    if (readHeading(line)?.kind === "stop") {
      break;
    }

    if (looksLikeIngredientLine(line)) {
      for (const text of splitIngredientLine(stripListNumber(line))) {
        ingredients.push({ text, section });
      }
      inList = true;
      continue;
    }

    const subsection = readSubsectionHeading(line) ?? readSectionWordHeading(line, next);

    if (subsection) {
      section = subsection;
      inList = true;
      continue;
    }

    if (isListNote(contentLines, index)) {
      notes.push(stripStepMarker(line));
      inList = false;
      continue;
    }

    /*
     * "Salt", "Fresh basil": short and unmeasured, kept inside the list (more amounts follow) or
     * at its end, straight after an ingredient.
     */
    if (
      (inList || (next !== undefined && looksLikeIngredientLine(next))) &&
      looksLikeUnmeasuredItem(line) &&
      !contentLines[index]!.note
    ) {
      ingredients.push({ text: line, section });
      inList = true;
      continue;
    }

    break;
  }

  const measured = ingredients.filter(
    (ingredient) =>
      startsWithQuantity(ingredient.text) || quantityWithUnitPattern.test(ingredient.text)
  ).length;

  if (ingredients.length < 3 || measured < 2) {
    return null;
  }

  const stepBuilder: StepBuilder = { steps: [], numbered: false, pendingPrefix: null };

  for (const { text: line } of contentLines.slice(index)) {
    if (readHeading(line)?.kind === "stop") {
      break;
    }

    if (looksLikeStepLine(line) || line.length >= 25) {
      addStepLine(stepBuilder, line);
    }
  }

  const titleLine = contentLines
    .slice(0, start)
    .map((line) => line.text)
    .find(looksLikeTitleLine);

  return {
    title: titleLine ? cleanTitle(titleLine) : null,
    ingredients,
    steps: [...notes, ...stepBuilder.steps],
    ...metadata,
    structure: "layout",
    methodSource: stepBuilder.steps.length > 0 ? "layout" : notes.length > 0 ? "notes" : null
  };
};

const emptyParse = (metadata: Metadata): ParsedRecipeText => ({
  title: null,
  ingredients: [],
  steps: [],
  ...metadata,
  structure: null,
  methodSource: null
});

/* Drops chrome lines, and ends the text at a video's sign-off once a recipe has started. */
const readTextLines = (text: string): TextLine[] => {
  const lines: TextLine[] = [];

  for (const rawLine of toLines(text.slice(0, 20_000))) {
    const cleaned = stripDecorations(rawLine);

    /* Before the noise filter: "Thanks for watching" is also promotional, but it ends the recipe. */
    if (isOutroLine(cleaned)) {
      if (lines.some((line) => looksLikeIngredientLine(line.text))) {
        break;
      }

      continue;
    }

    if (isNoiseLine(rawLine, cleaned)) {
      continue;
    }

    lines.push({ text: cleaned, note: /^\s*\*(?!\*)/u.test(rawLine) });
  }

  return lines;
};

export const parseRecipeText = (text: string): ParsedRecipeText => {
  const lines = readTextLines(text);
  const newMetadata = (): Metadata => ({
    servings: null,
    prepTimeMinutes: null,
    cookTimeMinutes: null,
    totalTimeMinutes: null
  });
  const headingMetadata = newMetadata();
  const withHeadings = parseWithHeadings(lines, headingMetadata);

  if (withHeadings?.structure) {
    return withHeadings;
  }

  const layoutMetadata = newMetadata();
  return parseByLayout(lines, layoutMetadata) ?? emptyParse(headingMetadata);
};

/** Links in free text (a YouTube description), in order of appearance, with the line around each. */
export const findTextLinks = (text: string): { url: string; line: string }[] =>
  text
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .flatMap((line, lineIndex, allLines) =>
      [...line.matchAll(urlPattern)].map((match) => ({
        url: match[0].replace(/[.,;:!?]+$/u, ""),
        /* "Full recipe:" is often on the line above its link. */
        line: `${allLines[lineIndex - 1] ?? ""} ${line}`
      }))
    );
