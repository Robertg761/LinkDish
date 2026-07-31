export type UpgradeMomentTrigger =
  | "fourth_import_monthly"
  | "share_to_family_no_plan"
  | "save_limit"
  | "share_sheet_quota_exceeded";

export const createUpgradeMomentSessionGate = () => {
  const seenTriggers = new Set<UpgradeMomentTrigger>();

  return {
    shouldOpen: (trigger: UpgradeMomentTrigger, activeTrigger: UpgradeMomentTrigger | null) => {
      if (activeTrigger || seenTriggers.has(trigger)) {
        return false;
      }

      seenTriggers.add(trigger);
      return true;
    }
  };
};
