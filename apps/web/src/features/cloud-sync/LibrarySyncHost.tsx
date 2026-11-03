import { useEffect, useRef } from "react";

import { useAuth } from "../../auth/AuthProvider";
import { useBootSettled } from "../../platform/boot-settle";

/**
 * Keeps cloud sync told who is signed in. The sync itself (and the API contracts it validates
 * with) loads once the first screen has settled, and only after someone has signed in: a
 * signed-out visit never downloads it.
 */
export const LibrarySyncHost: React.FC = () => {
  const { credentialsKey, isAuthenticated, loading, user } = useAuth();
  const settled = useBootSettled();
  const loaded = useRef(false);
  const userId = user?.id ?? null;

  useEffect(() => {
    if (!settled || (!isAuthenticated && !loaded.current)) {
      return;
    }

    let current = true;
    loaded.current = true;

    void import("./library-sync").then(({ setLibrarySyncAccount }) => {
      if (current) {
        setLibrarySyncAccount({ credentialsKey, isAuthenticated, loading, userId });
      }
    });

    return () => {
      current = false;
    };
  }, [credentialsKey, isAuthenticated, loading, settled, userId]);

  return null;
};
