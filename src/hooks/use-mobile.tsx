import * as React from "react";

// Mobile breakpoint set to 1024px to cover all mobile devices including larger phones
// and small tablets in portrait mode. Common mobile viewport widths:
// - iPhone 13: 390px
// - Pixel 8a: ~412px  
// - Larger phones/tablets: up to ~1024px
const MOBILE_BREAKPOINT = 1024;

export function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState<boolean | undefined>(undefined);

  React.useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
    const onChange = () => {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    };
    mql.addEventListener("change", onChange);
    setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return !!isMobile;
}
