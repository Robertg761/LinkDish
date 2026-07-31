export function isOnline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine;
}

export function addNetworkListeners(options: {
  onOffline?: () => void;
  onOnline?: () => void;
}): () => void {
  const handleOffline = () => options.onOffline?.();
  const handleOnline = () => options.onOnline?.();

  window.addEventListener("offline", handleOffline);
  window.addEventListener("online", handleOnline);

  return () => {
    window.removeEventListener("offline", handleOffline);
    window.removeEventListener("online", handleOnline);
  };
}
