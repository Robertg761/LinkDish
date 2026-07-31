export function isIos(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return false;
  }
  
  const userAgent = navigator.userAgent || "";
  const isIosDevice = /iPad|iPhone|iPod/.test(userAgent) && !(window as { MSStream?: unknown }).MSStream;
  
  // Also handle newer iPads which report as Macintosh
  const isMacintoshWithTouch = navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
  
  return isIosDevice || isMacintoshWithTouch;
}
