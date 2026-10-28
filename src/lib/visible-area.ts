// The part of the page a person can see: on a phone the on-screen keyboard
// covers the lower part of the window. The viewport meta asks the browser to
// shrink the page instead (`interactive-widget=resizes-content`, index.html);
// where the browser ignores that and only shrinks the visual viewport, these
// variables carry the visible height and its offset, so a full-screen view
// (the phone composer) can size itself to the area above the keyboard.
//
// Written on <html> as `--visible-height` and `--visible-top`; unset while the
// page is pinch-zoomed, where the visual viewport is a window into the page
// rather than the area above the keyboard. A rule falls back to `100dvh` and 0.

const PROPERTIES = { height: '--visible-height', top: '--visible-top' } as const;

/** The visible height in CSS pixels: the visual viewport's, else the window's. */
export function visibleHeight(): number {
  const viewport = window.visualViewport;
  return viewport && Math.abs(viewport.scale - 1) < 0.01 ? viewport.height : window.innerHeight;
}

/** Keeps the variables up to date; returns a function that stops and removes them. */
export function trackVisibleArea(root: HTMLElement = document.documentElement): () => void {
  const viewport = window.visualViewport;
  const apply = () => {
    if (!viewport || Math.abs(viewport.scale - 1) >= 0.01) {
      root.style.removeProperty(PROPERTIES.height);
      root.style.removeProperty(PROPERTIES.top);
      return;
    }
    root.style.setProperty(PROPERTIES.height, `${Math.round(viewport.height)}px`);
    root.style.setProperty(PROPERTIES.top, `${Math.round(viewport.offsetTop)}px`);
  };
  viewport?.addEventListener('resize', apply);
  viewport?.addEventListener('scroll', apply);
  window.addEventListener('resize', apply);
  apply();
  return () => {
    viewport?.removeEventListener('resize', apply);
    viewport?.removeEventListener('scroll', apply);
    window.removeEventListener('resize', apply);
    root.style.removeProperty(PROPERTIES.height);
    root.style.removeProperty(PROPERTIES.top);
  };
}
