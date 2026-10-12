import { useSyncExternalStore } from 'react';

// Layout follows the window width only. Touch support says nothing about the
// space available (touch laptops, narrow desktop windows), so it no longer
// switches layouts.
//
// The queries ask "is the window narrow?" so that a test environment whose
// matchMedia never matches renders the wide layout.

/** Phone layout: top bar per page and bottom navigation (Tailwind below `md`). */
export const PHONE_QUERY = '(max-width: 767px)';
/** Context panels open as a sheet instead of a column (below `lg`). */
export const NARROW_QUERY = '(max-width: 1023px)';

export function useMediaQuery(query: string) {
  return useSyncExternalStore(
    (notify) => {
      const list = window.matchMedia(query);
      list.addEventListener?.('change', notify);
      return () => list.removeEventListener?.('change', notify);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** True for the phone layout. Mail uses it for full-screen dialogs and bottom sheets. */
export function useIsMobile() {
  return useMediaQuery(PHONE_QUERY);
}
