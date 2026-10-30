import { useEffect } from 'react';

/** Focuses the input with `id` once it exists (a form row or section that was just added). */
export function useFocusAfterAdd(id: string | null, clear: () => void) {
  useEffect(() => {
    if (!id) return;
    const frame = requestAnimationFrame(() => { document.getElementById(id)?.focus(); clear(); });
    return () => cancelAnimationFrame(frame);
  }, [id, clear]);
}
