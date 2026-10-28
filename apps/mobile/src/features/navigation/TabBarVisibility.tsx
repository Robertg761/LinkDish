import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";

import type { NativeScrollEvent, NativeSyntheticEvent } from "react-native";

const TabBarVisibilityContext = createContext<{
  visible: boolean;
  setVisible: (visible: boolean) => void;
}>({
  visible: true,
  setVisible: () => {}
});

export const TabBarVisibilityProvider = ({ children }: { children: React.ReactNode }) => {
  const [visible, setVisible] = useState(true);
  const value = useMemo(() => ({ visible, setVisible }), [visible]);
  return (
    <TabBarVisibilityContext.Provider value={value}>{children}</TabBarVisibilityContext.Provider>
  );
};

export const useTabBarVisibility = () => useContext(TabBarVisibilityContext);

export const useTabBarScroll = () => {
  const { setVisible } = useTabBarVisibility();
  const lastY = useRef(0);
  const anchor = useRef(0);
  return useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const y = Math.max(0, event.nativeEvent.contentOffset.y);
      if (y <= 8) {
        setVisible(true);
        anchor.current = y;
      } else {
        if ((y - lastY.current) * (lastY.current - anchor.current) < 0)
          anchor.current = lastY.current;
        const delta = y - anchor.current;
        if (Math.abs(delta) >= 18) {
          setVisible(delta < 0);
          anchor.current = y;
        }
      }
      lastY.current = y;
    },
    [setVisible]
  );
};
