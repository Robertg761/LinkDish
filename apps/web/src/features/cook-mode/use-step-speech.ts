import { useEffect } from "react";

export const isSpeechSupported = (): boolean =>
  typeof window !== "undefined" &&
  "speechSynthesis" in window &&
  typeof window.SpeechSynthesisUtterance === "function";

/** Reads `text` aloud whenever it changes while `enabled` (and stops when disabled or closed). */
export const useStepSpeech = (enabled: boolean, text: string | null): void => {
  useEffect(() => {
    if (!enabled || !text || !isSpeechSupported()) {
      return;
    }

    const synth = window.speechSynthesis;

    try {
      synth.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 0.98;
      synth.speak(utterance);
    } catch {
      // Speech can fail on some platforms; the step is still on screen.
    }

    return () => {
      try {
        synth.cancel();
      } catch {
        // Ignore.
      }
    };
  }, [enabled, text]);
};
