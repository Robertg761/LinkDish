import { extractFirstUrl } from "@linkdish/recipe-domain";
import React, { useEffect, useId, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { Button } from "../../components/Button";
import { Icon } from "../../components/Icon";
import { RecipeImage } from "../../components/RecipeImage";
import { Sheet } from "../../components/Sheet";
import { getFeaturedRecipeBySlug } from "../featured/featured-recipes";

import "./FirstRunOnboardingSheet.css";

/**
 * The first-run welcome: three short frames with real product pieces (a recipe card, cook mode,
 * the shopping list), ending on a paste field and a sample recipe. Loaded on demand by
 * FirstRunOnboardingSheet, so returning cooks never download it.
 */

export const SAMPLE_RECIPE_SLUG = "classic-chocolate-chip-cookies";

const FRAMES = [
  {
    body: "Paste a link from any recipe site, video or caption, or snap a cookbook page. LinkDish keeps just the recipe.",
    id: "save",
    title: "Save recipes from anywhere"
  },
  {
    body: "Big steps, timers that keep running and a screen that stays awake. Then one tidy shopping list, sorted by aisle.",
    id: "cook",
    title: "Cook calmly, shop smarter"
  },
  {
    body: "Paste a link to a recipe you love, or open one we’ve already tidied up.",
    id: "start",
    title: "Start with one recipe"
  }
] as const;

type FrameId = (typeof FRAMES)[number]["id"];

const sample = getFeaturedRecipeBySlug(SAMPLE_RECIPE_SLUG);

const SaveArt: React.FC = () => (
  <div aria-hidden="true" className="first-run-stage is-save">
    <div className="first-run-paste-mock">
      <Icon name="link" size={16} />
      <span className="first-run-paste-mock-url">kingarthurbaking.com/recipes/chocolate-chip…</span>
      <span className="first-run-paste-mock-go">Get it</span>
    </div>
    <div className="first-run-mini-card">
      <RecipeImage
        aspectRatio="16 / 10"
        image={sample?.recipe.image}
        priority
        sizes="280px"
        title={sample?.recipe.title ?? "Cookies"}
        widths={[480]}
      />
      <div className="first-run-mini-card-body">
        <span className="first-run-mini-card-title">
          {sample?.recipe.title ?? "Classic Chocolate Chip Cookies"}
        </span>
        <span className="first-run-mini-card-meta">
          <Icon name="clock" size={13} /> 24 min <Icon name="users" size={13} /> 36 cookies
        </span>
      </div>
    </div>
    <span className="first-run-float is-video">
      <Icon name="play" size={13} /> YouTube
    </span>
    <span className="first-run-float is-social">
      <Icon name="sparkles" size={13} /> TikTok
    </span>
    <span className="first-run-float is-photo">
      <Icon name="camera" size={13} /> Photos
    </span>
  </div>
);

const CookArt: React.FC = () => (
  <div aria-hidden="true" className="first-run-stage is-cook">
    <div className="first-run-cook">
      <div className="first-run-cook-top">
        <span className="first-run-cook-step">Step 2 of 9</span>
        <span className="first-run-cook-timer num">
          <Icon name="timer" size={14} /> 02:48
        </span>
      </div>
      <p className="first-run-cook-text">
        Beat the butter and sugars until light and fluffy, about 3 minutes.
      </p>
      <div className="first-run-cook-chips">
        <span className="first-run-cook-chip num">½ cup butter</span>
        <span className="first-run-cook-chip num">¾ cup brown sugar</span>
      </div>
      <span className="first-run-cook-progress">
        <span />
      </span>
    </div>
    <div className="first-run-list">
      <span className="first-run-list-aisle">Produce</span>
      <span className="first-run-list-row is-checked">
        <span className="first-run-list-box">
          <Icon name="check" size={12} strokeWidth={3} />
        </span>
        <span className="num">2 lemons</span>
      </span>
      <span className="first-run-list-row">
        <span className="first-run-list-box" />
        <span className="num">1 ½ cups snap peas</span>
      </span>
      <span className="first-run-list-row">
        <span className="first-run-list-box" />
        <span>Fresh basil</span>
      </span>
    </div>
  </div>
);

interface StartFrameProps {
  onImport: (url: string) => void;
  onSample: () => void;
}

const StartFrame: React.FC<StartFrameProps> = ({ onImport, onSample }) => {
  const inputId = useId();
  const errorId = useId();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = value.trim();
    const url =
      extractFirstUrl(trimmed) ??
      (/^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/\S*)?$/iu.test(trimmed) ? `https://${trimmed}` : null);

    if (!url) {
      setError(
        trimmed
          ? "That doesn't look like a link. Try the full address, like https://…"
          : "Paste the address of a recipe page first."
      );
      return;
    }

    onImport(url);
  };

  return (
    <div className="first-run-start">
      <form className="first-run-start-form" noValidate onSubmit={submit}>
        <label className="sr-only" htmlFor={inputId}>
          Recipe link
        </label>
        <div className={`first-run-start-field${error ? " has-error" : ""}`}>
          <Icon className="first-run-start-icon" name="link" size={18} />
          <input
            aria-describedby={error ? errorId : undefined}
            aria-invalid={Boolean(error)}
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
            className="first-run-start-input"
            enterKeyHint="go"
            id={inputId}
            inputMode="url"
            onChange={(event) => {
              setValue(event.target.value);
              setError(null);
            }}
            placeholder="Paste a recipe link"
            spellCheck={false}
            type="text"
            value={value}
          />
        </div>
        {error ? (
          <p className="first-run-start-error" id={errorId} role="alert">
            <Icon name="alert-circle" size={15} /> {error}
          </p>
        ) : null}
        <Button fullWidth size="lg" trailingIcon="arrow-right" type="submit" variant="accent">
          Get the recipe
        </Button>
      </form>

      <p aria-hidden="true" className="first-run-or">
        <span>or</span>
      </p>

      <button className="first-run-sample" onClick={onSample} type="button">
        <span className="first-run-sample-media">
          <RecipeImage
            aspectRatio="1"
            image={sample?.recipe.image}
            sizes="64px"
            title={sample?.recipe.title ?? "Sample recipe"}
            widths={[96]}
          />
        </span>
        <span className="first-run-sample-copy">
          <span className="first-run-sample-title">Try a sample recipe</span>
          <span className="first-run-sample-meta">
            {sample?.recipe.title ?? "Classic Chocolate Chip Cookies"}
          </span>
        </span>
        <Icon className="first-run-sample-chevron" name="chevron-right" size={20} />
      </button>
    </div>
  );
};

export interface FirstRunOnboardingDialogProps {
  /** Called when the visitor skips or finishes (the flag is stored by the caller). */
  onFinish: () => void;
}

export const FirstRunOnboardingDialog: React.FC<FirstRunOnboardingDialogProps> = ({ onFinish }) => {
  const navigate = useNavigate();
  const [frameIndex, setFrameIndex] = useState(0);
  const frameTitleRef = useRef<HTMLParagraphElement>(null);
  const movedRef = useRef(false);
  const frame = FRAMES[frameIndex] ?? FRAMES[0];
  const finalFrame = frameIndex === FRAMES.length - 1;

  // After Next, land on the new frame's title: a screen reader reads it, and focus never falls
  // to the page when the last frame swaps Next out of the footer.
  useEffect(() => {
    if (movedRef.current) {
      frameTitleRef.current?.focus({ preventScroll: true });
    }
  }, [frameIndex]);

  const goTo = (path: string) => {
    onFinish();
    void navigate(path);
  };

  const art: Record<FrameId, React.ReactNode> = {
    cook: <CookArt />,
    save: <SaveArt />,
    start: null
  };

  return (
    <Sheet
      className="first-run-sheet"
      footer={
        <div className="first-run-footer">
          <div aria-hidden="true" className="first-run-progress">
            {FRAMES.map((item, index) => (
              <span
                className={`first-run-progress-dot${index === frameIndex ? " is-active" : ""}`}
                key={item.id}
              />
            ))}
          </div>
          <span className="sr-only">
            Step {frameIndex + 1} of {FRAMES.length}
          </span>
          <div className="first-run-footer-actions">
            <Button onClick={onFinish} variant="ghost">
              Skip
            </Button>
            {finalFrame ? null : (
              <Button
                onClick={() => {
                  movedRef.current = true;
                  setFrameIndex((current) => current + 1);
                }}
                trailingIcon="arrow-right"
              >
                Next
              </Button>
            )}
          </div>
        </div>
      }
      hideCloseButton
      hideTitle
      initialFocus="dialog"
      onClose={onFinish}
      open
      size="md"
      testId="first-run-onboarding"
      title={frame.title}
    >
      <div className={`first-run-frame is-${frame.id}`} key={frame.id}>
        {art[frame.id]}
        <div className="first-run-copy">
          <p className="first-run-title" ref={frameTitleRef} tabIndex={-1}>
            {frame.title}
          </p>
          <p className="first-run-body">{frame.body}</p>
        </div>
        {frame.id === "start" ? (
          <StartFrame
            onImport={(url) => goTo(`/import?url=${encodeURIComponent(url)}`)}
            onSample={() => goTo(`/featured/${SAMPLE_RECIPE_SLUG}`)}
          />
        ) : null}
      </div>
    </Sheet>
  );
};
