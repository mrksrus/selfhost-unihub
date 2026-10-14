import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { useResizableWidth } from '@/hooks/use-resizable-width';

const options = { defaultValue: 0.45, min: 0.3, max: 0.7 };

function Pane() {
  const pane = useRef<HTMLDivElement>(null);
  const width = useResizableWidth('w', { element: pane, ...options });
  return <div><div ref={pane}><div {...width.handle} aria-label="Width" /></div></div>;
}

afterEach(() => { cleanup(); localStorage.clear(); });

describe('useResizableWidth', () => {
  it('keeps the share within bounds, remembers it and resets to the default', () => {
    localStorage.setItem('w', '0.9');
    const element = { current: null };
    const first = renderHook(() => useResizableWidth('w', { element, ...options }));
    expect(first.result.current.value).toBe(0.7);
    act(() => first.result.current.set(0.1));
    expect(first.result.current.value).toBe(0.3);
    first.unmount();

    const second = renderHook(() => useResizableWidth('w', { element, ...options }));
    expect(second.result.current.value).toBe(0.3);
    act(() => second.result.current.reset());
    expect(second.result.current.value).toBe(0.45);
    expect(localStorage.getItem('w')).toBeNull();
  });

  it('measures a drag from the right edge of the parent and nudges with arrow keys', () => {
    render(<Pane />);
    const handle = screen.getByRole('separator', { name: 'Width' });
    const parent = handle.parentElement!.parentElement!;
    parent.getBoundingClientRect = () => ({ left: 200, right: 1200, width: 1000 } as DOMRect);
    let captured = false;
    handle.setPointerCapture = () => { captured = true; };
    handle.releasePointerCapture = () => { captured = false; };
    handle.hasPointerCapture = () => captured;

    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 700 });
    expect(handle).toHaveAttribute('aria-valuenow', '45');
    fireEvent.pointerDown(handle, { pointerId: 1, button: 0 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 700 });
    expect(handle).toHaveAttribute('aria-valuenow', '50');
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 250 });
    expect(handle).toHaveAttribute('aria-valuenow', '70');
    fireEvent.pointerUp(handle, { pointerId: 1 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 1000 });
    expect(handle).toHaveAttribute('aria-valuenow', '70');

    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(handle).toHaveAttribute('aria-valuenow', '68');
    expect(localStorage.getItem('w')).toBe('0.68');
    fireEvent.doubleClick(handle);
    expect(handle).toHaveAttribute('aria-valuenow', '45');
  });
});
