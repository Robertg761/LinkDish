/**
 * Method steps as the recipe editor holds them while they are being edited.
 *
 * Each row carries its own id so the editor can key rows, text input refs and
 * measured layouts by identity. Keying by array index instead re-points every
 * ref after a middle row is removed, which sends auto-focus and scroll-into-view
 * to the wrong row.
 */
export interface DraftStep {
  id: string;
  text: string;
}

let draftStepSequence = 0;

export const createDraftStep = (text = ""): DraftStep => {
  draftStepSequence += 1;

  return {
    id: `draft-step-${draftStepSequence}-${Math.random().toString(36).slice(2, 8)}`,
    text
  };
};

export const createDraftSteps = (texts: string[]): DraftStep[] => texts.map(createDraftStep);

export const appendDraftStep = (steps: DraftStep[]): DraftStep[] => [...steps, createDraftStep()];

export const removeDraftStep = (steps: DraftStep[], stepId: string): DraftStep[] => {
  if (!steps.some((step) => step.id === stepId)) {
    return steps;
  }

  const remainingSteps = steps.filter((step) => step.id !== stepId);

  return remainingSteps.length > 0 ? remainingSteps : [createDraftStep()];
};

export const updateDraftStep = (
  steps: DraftStep[],
  stepId: string,
  text: string
): DraftStep[] => {
  if (!steps.some((step) => step.id === stepId)) {
    return steps;
  }

  return steps.map((step) => (step.id === stepId ? { ...step, text } : step));
};

export const getDraftStepTexts = (steps: DraftStep[]): string[] =>
  steps.map((step) => step.text.trim()).filter(Boolean);
