import * as React from "react";

// Privacy-friendly mobile detection using feature detection instead of user-agent
// This approach respects user privacy by:
// 1. Using pointer media query (coarse = touch device)
// 2. Checking for touch capability
// 3. Falling back to viewport width as secondary indicator
// 
// This avoids user-agent detection which can be used for fingerprinting
const MOBILE_BREAKPOINT = 1200;

export function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState<boolean | undefined>(undefined);

  React.useEffect(() => {
    // Primary detection: Pointer media query (privacy-friendly, detects touch devices)
    // pointer: coarse = touch device (mobile/tablet)
    // pointer: fine = precise pointing device (mouse/trackpad)
    const pointerMql = window.matchMedia('(pointer: coarse)');
    
    // Secondary detection: Touch capability check
    const hasTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    
    // Tertiary detection: Viewport width (for edge cases like tablets in landscape)
    const viewportMql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
    
    const checkIsMobile = () => {
      // If device has coarse pointer (touch) OR has touch capability, it's mobile
      // Also check viewport for edge cases (e.g., tablet in portrait might be < 1200px)
      const isTouchDevice = pointerMql.matches || hasTouch;
      const isSmallViewport = viewportMql.matches;
      
      // Mobile if: touch device OR (small viewport AND touch capable)
      setIsMobile(isTouchDevice || (isSmallViewport && hasTouch));
    };
    
    // Listen to changes
    pointerMql.addEventListener("change", checkIsMobile);
    viewportMql.addEventListener("change", checkIsMobile);
    
    // Initial check
    checkIsMobile();
    
    return () => {
      pointerMql.removeEventListener("change", checkIsMobile);
      viewportMql.removeEventListener("change", checkIsMobile);
    };
  }, []);

  return !!isMobile;
}
