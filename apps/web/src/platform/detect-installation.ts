export function isStandaloneMode(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  
  const isStandaloneMatch = window.matchMedia?.("(display-mode: standalone)").matches;
  const isNavigatorStandalone = "standalone" in window.navigator && Boolean((window.navigator as { standalone?: boolean }).standalone);
  
  return !!(isStandaloneMatch || isNavigatorStandalone);
}
