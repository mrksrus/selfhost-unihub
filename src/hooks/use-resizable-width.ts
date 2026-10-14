import { useCallback, useState, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';

// The share of its parent (0..1) that an element takes, dragged from a handle
// on its left edge and kept in this browser. A fraction survives window
// resizing better than pixels. Storage may be disabled: the default is used then.

interface Options {
  /** The element whose width is the share of its parent. */
  element: RefObject<HTMLElement | null>;
  defaultValue: number;
  min: number;
  max: number;
}

const STEP = 0.02;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function useResizableWidth(key: string, { element, defaultValue, min, max }: Options) {
  const [value, setValue] = useState(() => {
    try {
      const stored = Number(localStorage.getItem(key));
      return stored > 0 ? clamp(stored, min, max) : defaultValue;
    } catch {
      return defaultValue;
    }
  });
  const set = useCallback((next: number) => {
    const clamped = Math.round(clamp(next, min, max) * 1000) / 1000;
    setValue(clamped);
    try { localStorage.setItem(key, String(clamped)); } catch { /* Storage may be disabled. */ }
  }, [key, min, max]);
  const reset = useCallback(() => {
    setValue(defaultValue);
    try { localStorage.removeItem(key); } catch { /* Storage may be disabled. */ }
  }, [key, defaultValue]);

  const onPointerDown = (event: PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    // No text selection while dragging across the list or the message.
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent<HTMLElement>) => {
    const parent = element.current?.parentElement;
    if (!parent || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const rect = parent.getBoundingClientRect();
    if (rect.width > 0) set((rect.right - event.clientX) / rect.width);
  };
  const onPointerUp = (event: PointerEvent<HTMLElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    set(value + (event.key === 'ArrowLeft' ? STEP : -STEP));
  };

  /** Spread onto the drag handle: pointer and arrow-key resizing, double-click resets. */
  const handle = {
    role: 'separator' as const,
    'aria-orientation': 'vertical' as const,
    'aria-valuenow': Math.round(value * 100),
    'aria-valuemin': Math.round(min * 100),
    'aria-valuemax': Math.round(max * 100),
    tabIndex: 0,
    onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp, onKeyDown, onDoubleClick: reset,
  };
  return { value, set, reset, handle };
}
