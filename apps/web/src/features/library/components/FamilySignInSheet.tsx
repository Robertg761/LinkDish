import React from "react";

import { Button, ButtonLink } from "../../../components/Button";
import { Sheet } from "../../../components/Sheet";

interface FamilySignInSheetProps {
  open: boolean;
  onClose: () => void;
}

/** Shown when a signed-out cook taps the Family tab. */
export const FamilySignInSheet: React.FC<FamilySignInSheetProps> = ({ open, onClose }) => (
  <Sheet
    description="Sign in to create or join a LinkDish Family household and share recipes with the people you cook with."
    footer={
      <>
        <Button onClick={onClose} variant="ghost">
          Cancel
        </Button>
        <ButtonLink to="/account" variant="primary">
          Sign in
        </ButtonLink>
      </>
    }
    onClose={onClose}
    open={open}
    size="sm"
    testId="library-family-sign-in"
    title="Cook together, in one place."
  >
    <ul className="library-family-perks">
      <li>One shared cookbook for up to 6 people</li>
      <li>A shopping list everyone can add to</li>
      <li>Your personal recipes stay yours</li>
    </ul>
  </Sheet>
);
