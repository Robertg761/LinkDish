import { describe, expect, it } from "vitest";

import {
  appendDraftStep,
  createDraftSteps,
  getDraftStepTexts,
  removeDraftStep,
  updateDraftStep
} from "./draftSteps";

describe("recipe editor draft steps", () => {
  it("gives every step a stable id", () => {
    const steps = createDraftSteps(["Chop.", "Simmer.", "Serve."]);

    expect(steps.map((step) => step.text)).toEqual(["Chop.", "Simmer.", "Serve."]);
    expect(new Set(steps.map((step) => step.id)).size).toBe(3);
  });

  it("keeps the ids of the surviving steps when a middle step is removed", () => {
    const steps = createDraftSteps(["Chop.", "Simmer.", "Serve."]);
    const remaining = removeDraftStep(steps, steps[1]!.id);

    expect(remaining.map((step) => step.text)).toEqual(["Chop.", "Serve."]);
    expect(remaining[0]?.id).toBe(steps[0]?.id);
    expect(remaining[1]?.id).toBe(steps[2]?.id);
  });

  it("edits the step that owns the id, not the one at that position", () => {
    const steps = createDraftSteps(["Chop.", "Simmer.", "Serve."]);
    const remaining = removeDraftStep(steps, steps[0]!.id);
    const edited = updateDraftStep(remaining, steps[2]!.id, "Serve hot.");

    expect(edited.map((step) => step.text)).toEqual(["Simmer.", "Serve hot."]);
    expect(edited.map((step) => step.id)).toEqual([steps[1]?.id, steps[2]?.id]);
  });

  it("always leaves one editable step behind", () => {
    const steps = createDraftSteps(["Only step."]);
    const remaining = removeDraftStep(steps, steps[0]!.id);

    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.text).toBe("");
    expect(remaining[0]?.id).not.toBe(steps[0]?.id);
  });

  it("appends a new empty step with a fresh id", () => {
    const steps = appendDraftStep(createDraftSteps(["Chop."]));

    expect(steps.map((step) => step.text)).toEqual(["Chop.", ""]);
    expect(steps[1]?.id).not.toBe(steps[0]?.id);
  });

  it("ignores ids that are no longer in the draft", () => {
    const steps = createDraftSteps(["Chop."]);

    expect(updateDraftStep(steps, "missing", "Nope")).toEqual(steps);
    expect(removeDraftStep(steps, "missing")).toEqual(steps);
  });

  it("returns trimmed, non-empty step text for saving", () => {
    const steps = createDraftSteps(["  Chop.  ", "", "Serve."]);

    expect(getDraftStepTexts(steps)).toEqual(["Chop.", "Serve."]);
  });
});
