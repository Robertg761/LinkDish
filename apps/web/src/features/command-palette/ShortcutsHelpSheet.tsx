import React from "react";

import { Sheet } from "../../components/Sheet";
import { getShortcutDefinitions } from "../../lib/shortcuts";

import "./ShortcutsHelpSheet.css";

/** "?": the keyboard shortcuts, as a cheat sheet. */
export const ShortcutsHelpSheet: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const shortcuts = getShortcutDefinitions();

  return (
    <Sheet
      description="Get around LinkDish without reaching for the mouse."
      onClose={onClose}
      open
      size="sm"
      testId="shortcuts-help"
      title="Keyboard shortcuts"
    >
      <dl className="shortcuts-help-list">
        {shortcuts.map((shortcut) => (
          <div className="shortcuts-help-row" key={shortcut.id}>
            <dt>{shortcut.label}</dt>
            <dd aria-label={shortcut.aria}>
              {shortcut.keys.map((key, index) => (
                <React.Fragment key={key}>
                  {index > 0 && shortcut.sequence ? (
                    <span className="shortcuts-help-then">then</span>
                  ) : null}
                  <kbd>{key}</kbd>
                </React.Fragment>
              ))}
            </dd>
          </div>
        ))}
      </dl>
      <p className="shortcuts-help-note">
        Letter shortcuts pause while you type in a field or a dialog is open.
      </p>
    </Sheet>
  );
};
