export const SAVE_FEEDBACK_EVENT = "linkdish:save-feedback";

export const requestSaveFeedback = () => {
  window.dispatchEvent(new CustomEvent(SAVE_FEEDBACK_EVENT));
};
