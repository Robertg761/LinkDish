import React, { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";

import { Button } from "./Button";
import "./ConfirmationDialog.css";

interface ConfirmationDialogProps {
  cancelLabel?: string;
  confirmLabel: string;
  confirmLoading?: boolean;
  message: React.ReactNode;
  onCancel: () => void;
  onConfirm: () => void;
  title: string;
  visible: boolean;
}

export const ConfirmationDialog: React.FC<ConfirmationDialogProps> = ({
  cancelLabel = "Cancel",
  confirmLabel,
  confirmLoading = false,
  message,
  onCancel,
  onConfirm,
  title,
  visible
}) => {
  const titleId = useId();
  const messageId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const confirmLoadingRef = useRef(confirmLoading);
  const onCancelRef = useRef(onCancel);
  confirmLoadingRef.current = confirmLoading;
  onCancelRef.current = onCancel;

  useEffect(() => {
    if (!visible) {
      return;
    }

    const previouslyFocusedElement = document.activeElement;
    dialogRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !confirmLoadingRef.current) {
        event.preventDefault();
        onCancelRef.current();
        return;
      }

      if (event.key === "Tab") {
        const focusableButtons = Array.from(
          dialogRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []
        );
        const firstButton = focusableButtons[0];
        const lastButton = focusableButtons[focusableButtons.length - 1];

        if (event.shiftKey && document.activeElement === firstButton && lastButton) {
          event.preventDefault();
          lastButton.focus();
        } else if (!event.shiftKey && document.activeElement === lastButton && firstButton) {
          event.preventDefault();
          firstButton.focus();
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);

      if (previouslyFocusedElement instanceof HTMLElement) {
        previouslyFocusedElement.focus();
      }
    };
  }, [visible]);

  if (!visible) {
    return null;
  }

  return createPortal(
    <div
      className="confirmation-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !confirmLoading) {
          onCancel();
        }
      }}
      role="presentation"
    >
      <section
        aria-describedby={messageId}
        aria-labelledby={titleId}
        aria-modal="true"
        className="confirmation-dialog"
        ref={dialogRef}
        role="dialog"
      >
        <div className="confirmation-dialog-copy">
          <h2 id={titleId}>{title}</h2>
          <div id={messageId}>{message}</div>
        </div>
        <div className="confirmation-dialog-actions">
          <Button disabled={confirmLoading} onClick={onCancel} variant="outline">
            {cancelLabel}
          </Button>
          <Button loading={confirmLoading} onClick={onConfirm} variant="danger">
            {confirmLabel}
          </Button>
        </div>
      </section>
    </div>,
    document.body
  );
};
